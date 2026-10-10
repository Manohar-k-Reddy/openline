package com.httpgateway.dialer.shell

import android.annotation.TargetApi
import android.app.Application
import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.os.Looper
import android.os.Process

/**
 * A bare `app_process` has no Application, and audioserver rejects audio clients whose
 * attribution package does not match the UID. Same workaround as scrcpy: install a fake
 * Application whose context reports uid 2000 / com.android.shell.
 */
internal object ShellRuntime {
    private const val SHELL_PACKAGE = "com.android.shell"

    fun install(): Context {
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper()
        val atClass = Class.forName("android.app.ActivityThread")
        var thread = atClass.getMethod("currentActivityThread").invoke(null)
        if (thread == null) {
            thread = atClass.getDeclaredConstructor().apply { isAccessible = true }.newInstance()
            atClass.field("sCurrentActivityThread").set(null, thread)
            atClass.field("mSystemThread").setBoolean(thread, true)
        }
        val system = atClass.getDeclaredMethod("getSystemContext").invoke(thread) as Context
        val shell = ShellContext(system)

        if (atClass.getMethod("currentApplication").invoke(null) == null) {
            if (atClass.field("mBoundApplication").get(thread) == null) {
                val bindClass = Class.forName("android.app.ActivityThread\$AppBindData")
                val bind = bindClass.getDeclaredConstructor().apply { isAccessible = true }.newInstance()
                bindClass.field("appInfo")
                    .set(bind, android.content.pm.ApplicationInfo().apply { packageName = SHELL_PACKAGE })
                atClass.field("mBoundApplication").set(thread, bind)
            }
            val app = Application()
            ContextWrapper::class.java.field("mBase").set(app, shell)
            atClass.field("mInitialApplication").set(thread, app)
        }
        return shell
    }

    private fun Class<*>.field(name: String) = getDeclaredField(name).apply { isAccessible = true }

    private class ShellContext(base: Context) : ContextWrapper(base) {
        override fun getPackageName(): String = SHELL_PACKAGE

        override fun getOpPackageName(): String = SHELL_PACKAGE

        @TargetApi(Build.VERSION_CODES.S)
        override fun getAttributionSource(): AttributionSource =
            AttributionSource.Builder(Process.SHELL_UID).setPackageName(SHELL_PACKAGE).build()

        override fun getApplicationContext(): Context = this
    }
}
