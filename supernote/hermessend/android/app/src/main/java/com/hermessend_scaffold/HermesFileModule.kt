package com.hermessend_scaffold

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import java.io.File
import java.io.FileOutputStream
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

  /**
   * Every page of a note, one above the next, as a single tall PNG.
   *
   * Ported from Scroll Export, which worked this out first. The SDK renders a
   * page at a time and has nothing that joins them, so this is the one job that
   * genuinely needs pixels: decode each page's bounds, make one bitmap as wide
   * as the widest and as tall as all of them, and draw each page centered.
   *
   * White rather than transparent. A note's ink is dark on paper, and a
   * transparent PNG of it looks like an empty file everywhere it is opened.
   *
   * Sizes are read with `inJustDecodeBounds` before anything is allocated: a
   * forty-page note at full resolution is a large bitmap, and finding that out
   * after decoding forty of them is how a device runs out of memory.
   */
  @ReactMethod
  fun stitchVertically(paths: ReadableArray, outPath: String, promise: Promise) {
    try {
      val n = paths.size()
      if (n == 0) {
        promise.reject("EEMPTY", "no pages to join")
        return
      }

      val heights = IntArray(n)
      var maxWidth = 0
      var totalHeight = 0
      for (i in 0 until n) {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(paths.getString(i), opts)
        if (opts.outWidth <= 0 || opts.outHeight <= 0) {
          promise.reject("EDECODE", "could not read the size of ${paths.getString(i)}")
          return
        }
        heights[i] = opts.outHeight
        if (opts.outWidth > maxWidth) maxWidth = opts.outWidth
        totalHeight += opts.outHeight
      }

      val dest = Bitmap.createBitmap(maxWidth, totalHeight, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(dest)
      canvas.drawColor(Color.WHITE)

      var y = 0
      for (i in 0 until n) {
        val page = BitmapFactory.decodeFile(paths.getString(i))
            ?: throw RuntimeException("could not read ${paths.getString(i)}")
        // Centered, because a page narrower than the widest would otherwise sit
        // against the left edge and the column would look broken.
        canvas.drawBitmap(page, (maxWidth - page.width) / 2f, y.toFloat(), null)
        y += heights[i]
        // Released as we go. Holding forty decoded pages to build one bitmap
        // needs twice the memory of holding one at a time.
        page.recycle()
      }

      File(outPath).parentFile?.mkdirs()
      FileOutputStream(outPath).use { out -> dest.compress(Bitmap.CompressFormat.PNG, 100, out) }
      dest.recycle()
      promise.resolve(outPath)
    } catch (t: Throwable) {
      promise.reject("ESTITCH", t.message ?: "the pages could not be joined", t)
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
