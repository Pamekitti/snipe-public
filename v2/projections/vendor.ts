/**
 * uPlot, inlined from projections/uplot rather than node_modules, because deploy is a tar
 * of source and a file under projections/ is guaranteed to be on the box.
 *
 * The directory is not named `vendor/`: that name is skipped by the laptop's pack (a
 * directory called vendor is treated as third-party junk), which is how the first ship
 * of this page had titles and no canvases.
 *
 * The try/catch is load-bearing. This module is imported by the live listener, so an
 * unguarded read here turns a missing asset into a bot that will not boot. A chartless page
 * is an acceptable failure; a dead trading process is not.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function loadVendor(): { js: string; css: string } {
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'uplot')
    return {
      js: readFileSync(join(dir, 'uPlot.iife.min.js'), 'utf8'),
      css: readFileSync(join(dir, 'uPlot.min.css'), 'utf8'),
    }
  } catch {
    return { js: '', css: '' }
  }
}
