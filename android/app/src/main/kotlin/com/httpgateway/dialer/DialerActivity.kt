package com.httpgateway.dialer

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.httpgateway.dialer.audio.CallAudioBridge
import com.httpgateway.dialer.config.GatewayConfig
import com.httpgateway.dialer.config.GatewayConfigStore
import com.httpgateway.dialer.config.GatewayPairing
import com.httpgateway.dialer.shell.PairingService
import com.httpgateway.dialer.shell.ShellLauncher
import com.httpgateway.dialer.telecom.CallCommandController
import com.httpgateway.dialer.transport.DeviceHealth
import com.httpgateway.dialer.transport.GatewayRuntime
import com.httpgateway.protocol.CommandAction
import com.httpgateway.protocol.GatewayCommand
import java.util.UUID

class DialerActivity : Activity() {
    private class Step(root: View, number: Int, title: String) {
        val badge: TextView = root.findViewById(R.id.stepNumber)
        val status: TextView = root.findViewById(R.id.stepStatus)
        val action: Button = root.findViewById(R.id.stepAction)

        init {
            badge.text = number.toString()
            root.findViewById<TextView>(R.id.stepTitle).text = title
        }

        fun render(done: Boolean, statusText: String, actionText: String?) {
            status.text = statusText
            badge.setBackgroundResource(if (done) R.drawable.step_badge_done else R.drawable.step_badge)
            badge.setTextColor(badge.context.getColor(if (done) R.color.on_ink else R.color.muted))
            action.visibility = if (actionText == null) View.GONE else View.VISIBLE
            if (actionText != null) action.text = actionText
        }
    }

    private lateinit var stepRole: Step
    private lateinit var stepServer: Step
    private lateinit var stepAudio: Step
    private lateinit var stepBattery: Step
    private lateinit var connectionDot: View
    private lateinit var connectionText: TextView
    private lateinit var numberInput: EditText
    private lateinit var wsUrlInput: EditText
    private lateinit var deviceIdInput: EditText
    private lateinit var deviceTokenInput: EditText

    private lateinit var configStore: GatewayConfigStore
    private lateinit var controller: CallCommandController
    private val handler = Handler(Looper.getMainLooper())
    private var pendingPermissionNumber: String? = null
    private var pairingMessage: String? = null
    private var audioStatus: CallAudioBridge.Status? = null
    private var wifiDialog: AlertDialog? = null
    private var wifiPromptShown = false
    /** Last start attempt said Wi-Fi is needed (adbd not reachable on mobile data). */
    private var needsWifi = false

    /** Wi-Fi came up while the screen is open: start call audio without another tap. */
    private val wifiCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            runOnUiThread {
                wifiDialog?.dismiss()
                if (audioStatus == CallAudioBridge.Status.STOPPED) refreshAudioStatus()
                else renderAudioStep()
            }
        }

        override fun onLost(network: Network) {
            runOnUiThread(::renderAudioStep)
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            renderConnection()
            handler.postDelayed(this, 1_500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configStore = GatewayConfigStore(this)
        controller = CallCommandController(this)
        applyDebugGatewayConfig(intent)
        setContentView(R.layout.activity_dialer)
        bindViews()
        applyDialIntent(intent)
        applyPairingIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyDebugGatewayConfig(intent)
        fillAdvancedFields()
        applyDialIntent(intent)
        applyPairingIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        wifiPromptShown = false
        renderSteps()
        refreshAudioStatus()
        handler.post(ticker)
        runCatching {
            getSystemService(ConnectivityManager::class.java).registerNetworkCallback(
                NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(),
                wifiCallback,
            )
        }
    }

    override fun onPause() {
        handler.removeCallbacks(ticker)
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(wifiCallback) }
        wifiDialog?.dismiss()
        super.onPause()
    }

    private fun bindViews() {
        findViewById<View>(R.id.root).setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        connectionDot = findViewById(R.id.connectionDot)
        connectionText = findViewById(R.id.connectionText)
        stepRole = Step(findViewById(R.id.stepRole), 1, "Default phone app")
        stepServer = Step(findViewById(R.id.stepServer), 2, "Connect to your gateway")
        stepAudio = Step(findViewById(R.id.stepAudio), 3, "Call audio")
        stepBattery = Step(findViewById(R.id.stepBattery), 4, "Stay online in the background")
        stepBattery.action.setOnClickListener { requestBackgroundRunning() }
        stepRole.action.setOnClickListener { requestDialerRole() }
        stepServer.action.setOnClickListener { scanPairingQr() }
        stepAudio.action.setOnClickListener {
            if (audioStatus == CallAudioBridge.Status.STOPPED) restartAudio() else startAudioSetup()
        }

        numberInput = findViewById(R.id.numberInput)
        findViewById<Button>(R.id.callButton).setOnClickListener { requestOrDial(numberInput.text.toString().trim()) }

        wsUrlInput = findViewById(R.id.wsUrlInput)
        deviceIdInput = findViewById(R.id.deviceIdInput)
        deviceTokenInput = findViewById(R.id.deviceTokenInput)
        fillAdvancedFields()
        val advanced = findViewById<View>(R.id.advanced)
        val toggle = findViewById<TextView>(R.id.advancedToggle)
        toggle.setOnClickListener {
            val show = advanced.visibility != View.VISIBLE
            advanced.visibility = if (show) View.VISIBLE else View.GONE
            toggle.text = if (show) "Hide advanced settings" else "Show advanced settings"
        }
        findViewById<Button>(R.id.saveConfigButton).setOnClickListener { saveGatewayConfig() }
        findViewById<Button>(R.id.restartAudioButton).setOnClickListener { restartAudio() }
    }

    private fun fillAdvancedFields() {
        if (!::wsUrlInput.isInitialized) return
        val config = configStore.load()
        wsUrlInput.setText(config.wsUrl)
        deviceIdInput.setText(config.deviceId)
        deviceTokenInput.setText(config.deviceToken)
    }

    // ---- Status ---------------------------------------------------------------------------

    private fun renderConnection() {
        val config = configStore.load()
        val host = config.wsUrl.let { runCatching { Uri.parse(it).host }.getOrNull() } ?: config.wsUrl
        val (color, text) = when {
            pairingMessage != null -> R.color.ring to pairingMessage!!
            config.deviceToken.isBlank() -> R.color.line to "Not connected to a gateway"
            GatewayRuntime.isConnected() -> R.color.live to "Online at $host"
            else -> R.color.bad to "Can't reach $host. Retrying."
        }
        connectionDot.backgroundTintList = ColorStateList.valueOf(getColor(color))
        connectionText.text = text
        renderServerStep(config, host)
    }

    private fun renderSteps() {
        val isDefault = getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_DIALER)
        stepRole.render(
            done = isDefault,
            statusText = if (isDefault) "This app handles the phone's calls." else "Needed to place and answer calls.",
            actionText = if (isDefault) null else "Set",
        )
        renderConnection()
        renderAudioStep()
        renderBatteryStep()
    }

    private fun renderBatteryStep() {
        val exempt = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        stepBattery.render(
            done = exempt,
            statusText = if (exempt) {
                "Allowed. On Vivo, also set Battery, then Background power consumption, to Allow for OpenLine."
            } else {
                "Without this the phone drops off the gateway after a few minutes."
            },
            actionText = if (exempt) "Vivo setting" else "Allow",
        )
    }

    /** Battery-optimisation exemption first; once granted, the button opens the app's settings for OEM power options. */
    private fun requestBackgroundRunning() {
        val exempt = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        val intent = if (exempt) {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
        } else {
            @Suppress("BatteryLife")
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        }
        runCatching { startActivity(intent) }.onFailure { toast("Open Settings, then Apps, then OpenLine, then Battery") }
    }

    private fun renderServerStep(config: GatewayConfig, host: String) {
        val paired = config.deviceToken.isNotBlank()
        stepServer.render(
            done = paired && GatewayRuntime.isConnected(),
            statusText = when {
                !paired -> "Scan the QR code shown in the admin console."
                GatewayRuntime.isConnected() -> host
                else -> "$host, not reachable right now."
            },
            actionText = if (paired) "Scan again" else "Scan QR",
        )
    }

    private fun renderAudioStep() {
        val (done, text, action) = when (audioStatus) {
            null -> Triple(false, "Checking…", null)
            CallAudioBridge.Status.READY -> Triple(true, "Ready. Calls stream to the gateway silently.", null)
            CallAudioBridge.Status.STOPPED ->
                if (needsWifi && !DeviceHealth.isOnWifi(this)) {
                    Triple(false, "Stopped. Connect to a Wi-Fi network once to start it; mobile data is fine after that.", "Start")
                } else {
                    Triple(false, "Set up, but stopped.", "Start")
                }
            CallAudioBridge.Status.SETUP_REQUIRED -> Triple(false, "One-time pairing with Wireless debugging.", "Set up")
        }
        stepAudio.render(done, text, action)
    }

    /**
     * Opening the app also (re)starts a stopped audio server, so nobody has to tap Start. Starting
     * goes through Wireless debugging, which Android only runs on Wi-Fi, so off Wi-Fi we ask for it.
     */
    private fun refreshAudioStatus() {
        Thread {
            var status = CallAudioBridge.status(this)
            var result: ShellLauncher.Result? = null
            if (status == CallAudioBridge.Status.STOPPED) {
                runOnUiThread { stepAudio.status.text = "Starting…" }
                result = ShellLauncher.ensureRunning(applicationContext)
                status = CallAudioBridge.status(this)
            }
            GatewayRuntime.reportHealthSoon()
            runOnUiThread {
                audioStatus = status
                needsWifi = result == ShellLauncher.Result.NeedsWifi
                renderAudioStep()
                if (needsWifi && !wifiPromptShown) showWifiRequired()
            }
        }.start()
    }

    /** Android can't switch Wi-Fi on for an app; this opens the Wi-Fi panel over the app instead. */
    private fun showWifiRequired() {
        if (isFinishing || wifiDialog?.isShowing == true) return
        wifiPromptShown = true
        val wifiOn = runCatching { getSystemService(WifiManager::class.java).isWifiEnabled }.getOrDefault(false)
        wifiDialog = AlertDialog.Builder(this, R.style.Gw_Dialog)
            .setTitle("Connect to a Wi-Fi network")
            .setMessage(
                (if (wifiOn) "Wi-Fi is on, but the phone isn't connected to a network yet. " else "") +
                    "OpenLine starts its call-audio helper through Android's Wireless debugging, which only " +
                    "runs while the phone is connected to a Wi-Fi network. Join any network for a moment " +
                    "(a hotspot from another phone works too). After that, calls work on mobile data " +
                    "until the phone restarts.",
            )
            .setPositiveButton("Open Wi-Fi") { _, _ -> openWifiSettings() }
            .setNegativeButton("Not now", null)
            .show()
    }

    private fun openWifiSettings() {
        val panel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Intent(Settings.Panel.ACTION_WIFI)
        } else {
            Intent(Settings.ACTION_WIFI_SETTINGS)
        }
        runCatching { startActivity(panel) }
            .recoverCatching { startActivity(Intent(Settings.ACTION_WIFI_SETTINGS)) }
            .onFailure { toast("Open Settings and turn on Wi-Fi") }
    }

    private fun restartAudio() {
        stepAudio.status.text = "Starting…"
        wifiPromptShown = false
        CallAudioBridge.restart(this) { result ->
            runOnUiThread {
                if (result == ShellLauncher.Result.NeedsWifi) {
                    needsWifi = true
                    audioStatus = CallAudioBridge.Status.STOPPED
                    renderAudioStep()
                    showWifiRequired()
                } else {
                    refreshAudioStatus()
                }
            }
        }
    }

    // ---- Actions --------------------------------------------------------------------------

    private fun requestDialerRole() {
        val roleManager = getSystemService(RoleManager::class.java)
        if (!roleManager.isRoleAvailable(RoleManager.ROLE_DIALER)) {
            toast("This phone doesn't let apps become the default phone app")
            return
        }
        startActivityForResult(roleManager.createRequestRoleIntent(RoleManager.ROLE_DIALER), REQUEST_DIALER_ROLE)
    }

    /** Starts pairing and opens the Wireless debugging screen. */
    private fun startAudioSetup() {
        if (!DeviceHealth.isOnWifi(this)) {
            showWifiRequired()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
            return
        }
        PairingService.start(this)
        val wirelessDebugging = Intent("android.settings.WIRELESS_DEBUGGING_SETTINGS")
        val target = if (wirelessDebugging.resolveActivity(packageManager) != null) {
            wirelessDebugging
        } else {
            Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
        }
        runCatching { startActivity(target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            .onFailure { toast("Open Settings, then Developer options, then Wireless debugging") }
        toast("Turn on Wireless debugging, tap \"Pair device with pairing code\", then use the notification")
    }

    @Deprecated("Deprecated in Android API; retained for the minimal permission flow.")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        if (requestCode == REQUEST_CALL_PHONE && granted) pendingPermissionNumber?.let(::dialLocally)
        if (requestCode == REQUEST_NOTIFICATIONS && granted) startAudioSetup()
        pendingPermissionNumber = null
    }

    private fun requestOrDial(number: String) {
        if (number.isBlank()) {
            numberInput.requestFocus()
            return
        }
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            pendingPermissionNumber = number
            requestPermissions(arrayOf(Manifest.permission.CALL_PHONE), REQUEST_CALL_PHONE)
            return
        }
        dialLocally(number)
    }

    private fun dialLocally(number: String) {
        val command = GatewayCommand(
            commandId = "local_${UUID.randomUUID()}",
            callId = "call_${UUID.randomUUID()}",
            action = CommandAction.DIAL,
            to = number,
        )
        controller.handle(command) { result ->
            if (!result.ok) runOnUiThread { toast(result.error ?: "Call failed") }
        }
    }

    private fun scanPairingQr() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { barcode ->
                val invite = barcode.rawValue?.let(GatewayPairing::parse)
                if (invite == null) toast("That QR code isn't from an OpenLine console") else pairWith(invite)
            }
            .addOnFailureListener { toast("Scanner unavailable: ${it.message}") }
    }

    /** Scanning the QR with the system camera opens httpgateway://pair?... directly. */
    private fun applyPairingIntent(intent: Intent) {
        val data = intent.data ?: return
        GatewayPairing.parse(data.toString())?.let(::pairWith)
        intent.data = null
    }

    private fun pairWith(invite: GatewayPairing.Invite) {
        pairingMessage = "Connecting to ${Uri.parse(invite.serverUrl).host}…"
        renderConnection()
        Thread {
            val result = runCatching { GatewayPairing.pair(this, invite) }
            runOnUiThread {
                pairingMessage = null
                result.onSuccess {
                    fillAdvancedFields()
                    GatewayRuntime.reconfigure()
                    toast("Connected to your gateway")
                }.onFailure {
                    toast("Couldn't connect: ${it.message}")
                }
                renderConnection()
            }
        }.start()
    }

    private fun saveGatewayConfig() {
        configStore.save(
            GatewayConfig(
                wsUrl = wsUrlInput.text.toString().trim(),
                deviceId = deviceIdInput.text.toString().trim(),
                deviceToken = deviceTokenInput.text.toString().trim(),
            ),
        )
        GatewayRuntime.reconfigure()
        toast("Saved. Reconnecting.")
    }

    /**
     * Debug-only hook used by emulator/instrumentation smoke tests. It lets adb
     * point a debug APK at a local gateway without baking credentials into the
     * app or exposing a production configuration surface through intents.
     */
    private fun applyDebugGatewayConfig(intent: Intent) {
        if (!BuildConfig.DEBUG) return
        val wsUrl = intent.getStringExtra(EXTRA_DEBUG_WS_URL) ?: return
        val deviceId = intent.getStringExtra(EXTRA_DEBUG_DEVICE_ID) ?: return
        val deviceToken = intent.getStringExtra(EXTRA_DEBUG_DEVICE_TOKEN) ?: return
        if (wsUrl.isBlank() || deviceId.isBlank() || deviceToken.isBlank()) return
        configStore.save(GatewayConfig(wsUrl = wsUrl, deviceId = deviceId, deviceToken = deviceToken))
        GatewayRuntime.reconfigure()
    }

    private fun applyDialIntent(intent: Intent) {
        if (intent.action == Intent.ACTION_DIAL) {
            intent.data?.schemeSpecificPart?.let { numberInput.setText(it) }
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    private companion object {
        const val REQUEST_DIALER_ROLE = 1001
        const val REQUEST_CALL_PHONE = 1002
        const val REQUEST_NOTIFICATIONS = 1003
        const val EXTRA_DEBUG_WS_URL = "debug_gateway_ws_url"
        const val EXTRA_DEBUG_DEVICE_ID = "debug_gateway_device_id"
        const val EXTRA_DEBUG_DEVICE_TOKEN = "debug_gateway_device_token"
    }
}
