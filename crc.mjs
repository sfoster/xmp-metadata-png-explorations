/*
 * Implementation of the CRC (Cyclic Redundancy Check) employed in PNG chunks
 * Ported from http://www.libpng.org/pub/png/spec/1.2/PNG-CRCAppendix.html
*/

/* Table of CRCs of all 8-bit messages. */
const crcTable = new Uint8Array(256);
let crcTableComputed = 0;

/* Make the table for a fast CRC. */
function makeCrcTable() {
 let c, n, k;

 for (n = 0; n < 256; n++) {
   c = n;
   for (k = 0; k < 8; k++) {
     if (c & 1)
       c = 0xedb88320 ^ (c >> 1);
     else
       c = c >> 1;
   }
   crcTable[n] = c;
 }
 crcTableComputed = 1;
}

/* Update a running CRC with the bytes buf[0..len-1]--the CRC
  should be initialized to all 1's, and the transmitted value
  is the 1's complement of the final running CRC (see the
  computeCrc() routine below.) */

function update_crc(crc, buf, len) {
  let c = crc;
  let n = 0;

  for (n = 0; n < len; n++) {
    c = crcTable[(c ^ buf[n]) & 0xff] ^ (c >> 8);
  }
  return c;
}

/* Return the CRC of the bytes buf[0..len-1]. */
function computeCrc(buf) {
  return update_crc(0xffffffff, buf, buf.length) ^ 0xffffffff;
}

if (!crcTableComputed) {
  makeCrcTable();
}

export { computeCrc, crcTable as crcLookupTable };