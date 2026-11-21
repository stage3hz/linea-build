package com.linea.messenger

import org.junit.runners.model.FrameworkMethod
import org.robolectric.RobolectricTestRunner
import org.robolectric.internal.bytecode.InstrumentationConfiguration

/** The pages built on the JVM with the real core behind them. A native library belongs to one class loader, and
 *  the plain tests have already loaded the core into theirs: with this runner the pages' `Core` is that very
 *  class (not a second copy of Robolectric's own loader, which could not load the library again), so the rules
 *  of the pages are the core's here too. Only for pages that reach the core through `Core.view`. */
class CoreSharingRunner(testClass: Class<*>) : RobolectricTestRunner(testClass) {
  override fun createClassLoaderConfig(method: FrameworkMethod): InstrumentationConfiguration =
    InstrumentationConfiguration.Builder(super.createClassLoaderConfig(method))
      .doNotAcquirePackage("com.linea.messenger.core.").doNotAcquirePackage("com.linea.core.json.")
      // Robolectric keeps one world per configuration and does not look at the lines above when it compares two:
      // this name (of nothing) makes the configuration its own, so the pages do not land in the other tests' world.
      .addInstrumentedPackage("com.linea.messenger.coreshared.").build()
}
