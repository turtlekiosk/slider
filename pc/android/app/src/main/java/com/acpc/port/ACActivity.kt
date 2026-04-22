package com.acpc.port

import android.os.Bundle
import androidx.core.view.WindowCompat
import org.libsdl.app.SDLActivity

/**
 * Main activity for the Animal Crossing PC port on Android.
 * Extends SDLActivity which handles EGL context, native library loading,
 * input events, and audio device management.
 */

class ACActivity: SDLActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		WindowCompat.enableEdgeToEdge(window)
	}

	override fun getLibraries() = arrayOf("SDL2", "ac_pc")
}