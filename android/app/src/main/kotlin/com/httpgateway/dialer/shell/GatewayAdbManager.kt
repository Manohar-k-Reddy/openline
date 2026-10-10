package com.httpgateway.dialer.shell

import android.content.Context
import android.os.Build
import io.github.muntashirakon.adb.AbsAdbConnectionManager
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.cert.Certificate
import java.security.cert.CertificateFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Date
import java.util.concurrent.TimeUnit

/** ADB client identity for this app; the key is what the phone remembers after pairing. */
class GatewayAdbManager private constructor(context: Context) : AbsAdbConnectionManager() {
    private val dir = File(context.filesDir, "adb").apply { mkdirs() }
    private val keyFile = File(dir, "adbkey.pk8")
    private val certFile = File(dir, "adbkey.crt")
    private val privateKey: PrivateKey
    private val certificate: Certificate

    init {
        api = Build.VERSION.SDK_INT
        if (!keyFile.exists() || !certFile.exists()) generate()
        privateKey = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(keyFile.readBytes()))
        certificate = certFile.inputStream().use { CertificateFactory.getInstance("X.509").generateCertificate(it) }
    }

    override fun getPrivateKey(): PrivateKey = privateKey

    override fun getCertificate(): Certificate = certificate

    override fun getDeviceName(): String = "httpgateway"

    private fun generate() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val name = X500Name("CN=httpgateway")
        val now = System.currentTimeMillis()
        val holder = JcaX509v3CertificateBuilder(
            name,
            BigInteger.valueOf(now),
            Date(now - TimeUnit.DAYS.toMillis(1)),
            Date(now + TimeUnit.DAYS.toMillis(365L * 30)),
            name,
            pair.public,
        ).build(JcaContentSignerBuilder("SHA256withRSA").build(pair.private))
        val cert = JcaX509CertificateConverter().getCertificate(holder)
        keyFile.writeBytes(pair.private.encoded)
        certFile.writeBytes(cert.encoded)
    }

    companion object {
        @Volatile
        private var instance: GatewayAdbManager? = null

        fun get(context: Context): GatewayAdbManager =
            instance ?: synchronized(this) {
                instance ?: GatewayAdbManager(context.applicationContext).also { instance = it }
            }
    }
}
