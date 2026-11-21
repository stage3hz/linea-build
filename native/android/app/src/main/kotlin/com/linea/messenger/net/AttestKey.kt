package com.linea.messenger.net

import com.linea.messenger.BuildConfig

/** The per-build key that signs state-changing requests (the server's check that a request comes from a real
 *  build). Empty in the repository — signing is then off; a release build is given the key from its secret
 *  (the Gradle property `attestKey` or the environment variable INVIZENT_ATTEST_KEY, see app/build.gradle.kts)
 *  and it is never committed and never written to a log. The server must hold the same key. */
val attestKey: String = BuildConfig.ATTEST_KEY
