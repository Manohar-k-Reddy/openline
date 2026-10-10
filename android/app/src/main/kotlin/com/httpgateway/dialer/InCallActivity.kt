package com.httpgateway.dialer

import android.app.Activity
import android.content.res.ColorStateList
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.Call
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.GridLayout
import android.widget.TextView
import android.widget.Toast
import com.httpgateway.dialer.telecom.CallCommandController
import com.httpgateway.dialer.telecom.CallRegistry
import com.httpgateway.protocol.CommandAction
import com.httpgateway.protocol.GatewayCommand
import java.util.UUID

class InCallActivity : Activity(), CallRegistry.Listener {
    private lateinit var stateDot: View
    private lateinit var stateText: TextView
    private lateinit var numberText: TextView
    private lateinit var timerText: TextView
    private lateinit var routedText: TextView
    private lateinit var ringingRow: View
    private lateinit var activeRow: View
    private lateinit var holdButton: Button
    private lateinit var keypad: GridLayout
    private lateinit var controller: CallCommandController
    private val handler = Handler(Looper.getMainLooper())

    private val ticker = object : Runnable {
        override fun run() {
            renderTimer()
            handler.postDelayed(this, 500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controller = CallCommandController(this)
        setContentView(R.layout.activity_in_call)
        findViewById<View>(R.id.root).setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars())
            view.setPadding(dp(24) + bars.left, dp(40) + bars.top, dp(24) + bars.right, dp(28) + bars.bottom)
            insets
        }
        stateDot = findViewById(R.id.stateDot)
        stateText = findViewById(R.id.stateText)
        numberText = findViewById(R.id.numberText)
        timerText = findViewById(R.id.timerText)
        routedText = findViewById(R.id.routedText)
        ringingRow = findViewById(R.id.ringingRow)
        activeRow = findViewById(R.id.activeRow)
        holdButton = findViewById(R.id.holdButton)
        keypad = findViewById(R.id.keypad)

        findViewById<Button>(R.id.answerButton).setOnClickListener { execute(CommandAction.ANSWER) }
        findViewById<Button>(R.id.declineButton).setOnClickListener { execute(CommandAction.REJECT) }
        findViewById<Button>(R.id.endButton).setOnClickListener { execute(CommandAction.HANGUP) }
        holdButton.setOnClickListener {
            val held = currentCall()?.let(CallRegistry::androidState) == Call.STATE_HOLDING
            execute(if (held) CommandAction.UNHOLD else CommandAction.HOLD)
        }
        findViewById<Button>(R.id.keypadButton).setOnClickListener {
            keypad.visibility = if (keypad.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        buildKeypad()
    }

    override fun onStart() {
        super.onStart()
        CallRegistry.addListener(this)
        render()
        handler.post(ticker)
    }

    override fun onStop() {
        handler.removeCallbacks(ticker)
        CallRegistry.removeListener(this)
        super.onStop()
    }

    override fun onCallsChanged() {
        runOnUiThread(::render)
    }

    private fun buildKeypad() {
        listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#").forEach { digit ->
            keypad.addView(
                Button(this, null, 0, R.style.Gw_Button).apply {
                    text = digit
                    textSize = 20f
                    setOnClickListener { execute(CommandAction.DTMF, digit) }
                },
                GridLayout.LayoutParams().apply {
                    width = dp(72)
                    height = dp(56)
                    setMargins(dp(6), dp(6), dp(6), dp(6))
                },
            )
        }
    }

    private fun currentCall(): Call? = CallRegistry.snapshot().firstOrNull()?.call

    private fun render() {
        val call = currentCall() ?: return finish()
        val state = CallRegistry.androidState(call)
        val incoming = call.details.callDirection == Call.Details.DIRECTION_INCOMING
        val canHold = (call.details.callCapabilities and Call.Details.CAPABILITY_HOLD) != 0

        numberText.text = call.details.handle?.schemeSpecificPart?.takeIf { it.isNotBlank() } ?: "Unknown number"
        val (color, label) = when (state) {
            Call.STATE_RINGING -> R.color.ring to "Incoming call"
            Call.STATE_DIALING, Call.STATE_CONNECTING -> R.color.ring to "Calling…"
            Call.STATE_ACTIVE, Call.STATE_AUDIO_PROCESSING -> R.color.live to "On call"
            Call.STATE_HOLDING -> R.color.muted to "On hold"
            Call.STATE_DISCONNECTING, Call.STATE_DISCONNECTED -> R.color.muted to "Call ended"
            else -> R.color.muted to (if (incoming) "Incoming call" else "Calling…")
        }
        stateDot.backgroundTintList = ColorStateList.valueOf(getColor(color))
        stateText.text = label

        val connected = state == Call.STATE_ACTIVE || state == Call.STATE_AUDIO_PROCESSING || state == Call.STATE_HOLDING
        routedText.visibility = if (state == Call.STATE_AUDIO_PROCESSING) View.VISIBLE else View.GONE
        ringingRow.visibility = if (state == Call.STATE_RINGING) View.VISIBLE else View.GONE
        activeRow.visibility = if (connected) View.VISIBLE else View.GONE
        holdButton.visibility = if (canHold || state == Call.STATE_HOLDING) View.VISIBLE else View.GONE
        holdButton.text = if (state == Call.STATE_HOLDING) "Resume" else "Hold"
        if (!connected) keypad.visibility = View.GONE
        renderTimer()
    }

    private fun renderTimer() {
        val call = currentCall() ?: return
        val since = call.details.connectTimeMillis
        if (since <= 0) {
            timerText.text = ""
            return
        }
        val seconds = ((System.currentTimeMillis() - since) / 1000).coerceAtLeast(0)
        timerText.text = "%d:%02d".format(seconds / 60, seconds % 60)
    }

    private fun execute(action: CommandAction, digits: String? = null) {
        val entry = CallRegistry.snapshot().firstOrNull() ?: return
        controller.handle(
            GatewayCommand(
                commandId = "local_ui_${UUID.randomUUID()}",
                callId = entry.callId,
                action = action,
                digits = digits,
            ),
        ) { result ->
            if (!result.ok) runOnUiThread { Toast.makeText(this, result.error ?: "That didn't work", Toast.LENGTH_SHORT).show() }
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
