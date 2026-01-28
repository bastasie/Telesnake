// ppujpeg.js - JPEG APP15 ("PPUJ") cartridge builder + loader (pre-SOS only)
// Marker schema follows APP15 payload described in the "Assembly line" doc.
// - All blocks live in APP15 (FFEF) before SOS (FFDA)
// - Flags: bit0 CRC32 present, bit1 zlib compressed, bit2 encrypted (NOT USED)
// - CRC32 covers bytes Magic..Payload (inclusive), excluding CRC field.

export const PPUJ_MAGIC = 0x5050554a; // "PPUJ"
export const APP15 = 0xEF;
export const SOI = 0xD8;
export const EOI = 0xD9;
export const SOS = 0xDA;

export const BlockType = Object.freeze({
  HEADER: 0x01,
  BYTECODE: 0x02,
  TRUTH_TABLE: 0x03,
  LUT_PALETTE: 0x04,
  STRING_TABLE: 0x05,
  SIGNATURE: 0x06,
  FS: 0x07, // optional extension
});

export function u8str(u8, off, len){
  return String.fromCharCode(...u8.subarray(off, off+len));
}

export function crc32(u8){
  // Standard CRC32 (IEEE 802.3), polynomial 0xEDB88320
  let c = 0xFFFFFFFF;
  for(let i=0;i<u8.length;i++){
    c ^= u8[i];
    for(let k=0;k<8;k++){
      const m = -(c & 1);
      c = (c >>> 1) ^ (0xEDB88320 & m);
    }
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function readU16BE(u8, off){ return (u8[off]<<8) | u8[off+1]; }
function readU32BE(u8, off){
  return ((u8[off]<<24)>>>0) | (u8[off+1]<<16) | (u8[off+2]<<8) | u8[off+3];
}
function writeU16BE(dv, off, v){ dv.setUint16(off, v & 0xFFFF, false); }
function writeU32BE(dv, off, v){ dv.setUint32(off, v >>> 0, false); }

export function buildApp15Block({blockType, payloadU8, version=0x01, flags={crc:true, compressed:false}}){
  const payload = payloadU8 instanceof Uint8Array ? payloadU8 : new Uint8Array(payloadU8);
  const flagByte = (flags.crc?1:0) | (flags.compressed?2:0); // bit2 intentionally unused
  const headerLen = 4+1+1+1+1+4;
  const crcLen = flags.crc ? 4 : 0;
  const total = headerLen + payload.length + crcLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  // Magic "PPUJ"
  out[0]=0x50; out[1]=0x50; out[2]=0x55; out[3]=0x4a;
  out[4]=version & 0xFF;
  out[5]=blockType & 0xFF;
  out[6]=flagByte & 0xFF;
  out[7]=0;

  writeU32BE(dv, 8, payload.length>>>0);
  out.set(payload, headerLen);

  if(flags.crc){
    const crc = crc32(out.subarray(0, headerLen + payload.length));
    writeU32BE(dv, headerLen + payload.length, crc);
  }

  return out;
}

export function injectBeforeSOS(jpegU8, appPayloads){
  // appPayloads: Uint8Array[] of APP15 payloads (already includes "PPUJ" header etc)
  const u8 = jpegU8 instanceof Uint8Array ? jpegU8 : new Uint8Array(jpegU8);
  if(u8.length < 4 || u8[0]!==0xFF || u8[1]!==SOI) throw new Error("Not a JPEG (missing SOI)");

  // Parse segments safely until SOS
  let p = 2;
  let sosOff = -1;
  while(p < u8.length){
    if(u8[p] !== 0xFF){ throw new Error("Malformed JPEG: expected marker 0xFF"); }
    // skip fill bytes 0xFF
    while(p < u8.length && u8[p] === 0xFF) p++;
    if(p >= u8.length) throw new Error("Malformed JPEG: truncated marker");
    const marker = u8[p++];
    if(marker === SOS){ sosOff = p-2; break; }
    if(marker === EOI){ throw new Error("Unexpected EOI before SOS"); }

    // Markers without length (RSTn 0xD0..0xD7, TEM 0x01)
    if((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01){
      continue;
    }
    if(p+2 > u8.length) throw new Error("Malformed JPEG: truncated segment length");
    const segLen = readU16BE(u8, p);
    if(segLen < 2) throw new Error("Malformed JPEG: invalid segment length");
    p += segLen; // length includes the 2 bytes we just read
  }
  if(sosOff < 0) throw new Error("Could not find SOS");

  // Build APP15 segments
  const segments = [];
  let segTotal = 0;
  for(const payload of appPayloads){
    const pl = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const segLen = pl.length + 2; // length field included
    if(segLen > 0xFFFF) throw new Error("APP15 segment too large");
    const seg = new Uint8Array(2 + 2 + pl.length);
    seg[0]=0xFF; seg[1]=APP15;
    const dv = new DataView(seg.buffer);
    writeU16BE(dv, 2, segLen);
    seg.set(pl, 4);
    segments.push(seg);
    segTotal += seg.length;
  }

  const out = new Uint8Array(u8.length + segTotal);
  out.set(u8.subarray(0, sosOff), 0);
  let off = sosOff;
  for(const seg of segments){
    out.set(seg, off);
    off += seg.length;
  }
  out.set(u8.subarray(sosOff), off);
  return out;
}

export function parseCartridge(jpegU8, {maxTotal=8*1024*1024} = {}){
  const u8 = jpegU8 instanceof Uint8Array ? jpegU8 : new Uint8Array(jpegU8);
  if(u8.length < 4 || u8[0]!==0xFF || u8[1]!==SOI) throw new Error("Not a JPEG (missing SOI)");

  const blocks = [];
  let totalPayload = 0;

  let p = 2;
  while(p < u8.length){
    if(u8[p] !== 0xFF) throw new Error("Malformed JPEG: expected marker 0xFF");
    while(p < u8.length && u8[p] === 0xFF) p++;
    if(p >= u8.length) throw new Error("Malformed JPEG: truncated marker");
    const marker = u8[p++];
    if(marker === SOS) break;
    if(marker === EOI) break;

    if((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01){
      continue;
    }

    if(p+2 > u8.length) throw new Error("Malformed JPEG: truncated segment length");
    const segLen = readU16BE(u8, p);
    if(segLen < 2) throw new Error("Malformed JPEG: invalid segment length");
    const segStart = p+2;
    const segEnd = p + segLen;
    if(segEnd > u8.length) throw new Error("Malformed JPEG: segment overruns file");
    if(marker === APP15){
      const pl = u8.subarray(segStart, segEnd);
      if(pl.length >= 12 && pl[0]===0x50 && pl[1]===0x50 && pl[2]===0x55 && pl[3]===0x4a){
        const version = pl[4];
        const blockType = pl[5];
        const flags = pl[6];
        const hasCrc = (flags & 1) !== 0;
        const encrypted = (flags & 4) !== 0;
        if(encrypted) throw new Error("Encrypted flag set (NOT USED per spec)"); // fail-closed
        const n = readU32BE(pl, 8);
        const headerLen = 12;
        const crcLen = hasCrc ? 4 : 0;
        if(headerLen + n + crcLen !== pl.length) throw new Error("PPUJ block length mismatch");
        totalPayload += n;
        if(totalPayload > maxTotal) throw new Error("Cartridge too large");
        const payload = pl.subarray(headerLen, headerLen+n);
        if(hasCrc){
          const want = readU32BE(pl, headerLen+n);
          const got = crc32(pl.subarray(0, headerLen+n));
          if((got>>>0) !== (want>>>0)) throw new Error("CRC32 mismatch");
        }
        blocks.push({version, blockType, flags, payload});
      }
    }
    p = segEnd;
  }

  return blocks;
}
