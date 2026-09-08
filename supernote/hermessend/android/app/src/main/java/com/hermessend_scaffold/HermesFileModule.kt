package com.hermessend_scaffold

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.security.MessageDigest

/**
 * The three things the Supernote SDK cannot do, and this plugin cannot work
 * without.
 *
 * `FileUtils` can tell you a file exists, list a directory, copy, rename, delete
 * and take an MD5 — and has no way to put a file's contents in front of
 * JavaScript. There is no read, no base64, no stream, on any module in the SDK.
 * So a plugin that wants to *send* a file it just made has to reach past the
 * SDK, and this is the whole of that reach: read bytes, hash bytes, and keep a
 * small settings file.
 *
 * SHA-256 is here rather than in JS for the same reason. The interchange format
 * requires a digest beside any bytes an attachment carries — bytes nobody can
 * check are bytes nobody should trust — and a pure-JS SHA-256 over a megabyte
 * of PNG on this hardware is slow enough to feel like a hang. `MessageDigest`
 * is instant and is already on the device.
 */
class HermesFileModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "HermesFile"

  /**
   * A file as base64, with its digest and its length.
   *
   * All three together because the caller needs all three and reading the file
   * twice to get them separately is the kind of thing that works on a small
   * selection and stalls on a page.
   *
   * `Base64.NO_WRAP`: the default inserts newlines every 76 characters, which is
   * MIME's rule and not JSON's, and a wrapped string is not what any decoder on
   * the other end expects.
   */
  @ReactMethod
  fun read(path: String, promise: Promise) {
    try {
      val file = File(path)
      if (!file.isFile) {
        promise.reject("ENOENT", "no file at $path")
        return
      }
      val bytes = file.readBytes()
      val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
      val out = Arguments.createMap()
      out.putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      out.putString("sha256", digest.joinToString("") { "%02x".format(it) })
      out.putInt("size", bytes.size)
      promise.resolve(out)
    } catch (err: Throwable) {
      promise.reject("EREAD", err.message ?: "could not read $path", err)
    }
  }

  /** Text out of a file, or null when there is no file. Absence is not an error:
   *  the first run of this plugin has no settings and that is the normal case. */
  @ReactMethod
  fun readText(path: String, promise: Promise) {
    try {
      val file = File(path)
      promise.resolve(if (file.isFile) file.readText(Charsets.UTF_8) else null)
    } catch (err: Throwable) {
      promise.reject("EREAD", err.message ?: "could not read $path", err)
    }
  }

  /**
   * Text into a file, by way of a temporary one.
   *
   * Written beside the target and renamed over it, so a write interrupted
   * halfway leaves the previous settings intact rather than a truncated file
   * that parses as nothing. This holds an access key; losing it to a battery
   * dying mid-write would mean pairing the device again.
   */
  @ReactMethod
  fun writeText(path: String, text: String, promise: Promise) {
    try {
      val target = File(path)
      target.parentFile?.mkdirs()
      val temp = File(target.parentFile, "${target.name}.tmp")
      temp.writeText(text, Charsets.UTF_8)
      if (!temp.renameTo(target)) {
        target.writeText(text, Charsets.UTF_8)
        temp.delete()
      }
      promise.resolve(true)
    } catch (err: Throwable) {
      promise.reject("EWRITE", err.message ?: "could not write $path", err)
    }
  }
}
