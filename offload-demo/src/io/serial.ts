import { parseDeviceLine, encodeSetpoints } from "./device.ts";
import type { Frame, Setpoints } from "../core/types.ts";

/**
 * Web Serial link to the controller board (Chrome/Edge, needs a click to open the port picker). Protocol: see device.ts.
 * NOT YET TESTED AGAINST REAL HARDWARE: the line parser is unit-tested, this port handling is not.
 */
export class SerialLink {
  static get supported() { return typeof navigator !== "undefined" && "serial" in navigator; }
  private port: any = null; private writer: any = null; private reader: any = null; private reading = false;
  private newest: Frame | null = null; private lastRx = 0;
  droppedLines = 0;

  async connect(baud = 115200) {
    const nav = navigator as any;
    this.port = await nav.serial.requestPort();
    await this.port.open({ baudRate: baud });
    this.writer = this.port.writable.getWriter(); this.reading = true; this.lastRx = performance.now();
    void this.readLoop();
  }
  private async readLoop() {
    const dec = new TextDecoder(); let buf = "";
    const reader = this.reader = this.port.readable.getReader();
    try {
      while (this.reading) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let k: number; while ((k = buf.indexOf("\n")) >= 0) {
          const f = parseDeviceLine(buf.slice(0, k)); buf = buf.slice(k + 1);
          if (f) { this.newest = f; this.lastRx = performance.now(); } else this.droppedLines++;
        }
        if (buf.length > 4096) buf = "";   // runaway line without a newline
      }
    } catch { /* port closed or unplugged: silence will trip the watchdog */ } finally { reader.releaseLock(); }
  }
  /** Latest frame since the last call (older ones are dropped), or null if nothing new arrived. */
  take(): Frame | null { const f = this.newest; this.newest = null; return f; }
  silentForS() { return (performance.now() - this.lastRx) / 1000; }
  async send(sp: Setpoints) { try { await this.writer?.write(new TextEncoder().encode(encodeSetpoints(sp))); } catch { /* ignore */ } }
  async disconnect() {
    this.reading = false;
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { this.writer?.releaseLock(); await this.port?.close(); } catch { /* ignore */ }
    this.port = null; this.writer = null;
  }
}
