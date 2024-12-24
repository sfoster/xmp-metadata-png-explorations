const encoder = new TextEncoder('utf-8')
const decoder = new TextDecoder();
let xmlParser;

// Helper to convert a 32-bit integer to a 4-byte big-endian array
export function uint32ToBytes(value) {
  return new Uint8Array([
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
  ]);
}

export const predefinedKeywords = new Set([
 "Title",            // Short (one line) title or caption for image
 "Author",           // Name of image's creator
 "Description",      // Description of image (possibly long)
 "Copyright",        // Copyright notice
 "Creation Time",    // Time of original image creation
 "Software",         // Software used to create the image
 "Disclaimer",       // Legal disclaimer
 "Warning",          // Warning of nature of content
 "Source",           // Device used to create the image
 "Comment",          // Miscellaneous comment
]);

/*
 * Assemble a PNG "iTXT" chunk using the provided text and keyword
 *
 * @param {String} text
 *   The text data for the chunk. See http://www.libpng.org/pub/png/spec/1.2/PNG-Chunks.html for details.
 * @param {String} keyword
 *   The keyword to use. Either one of the predefined keywords or one known to the target software
 * @returns {Uint8Array}
*/
export function createITXtChunk(text, keyword="XML:com.adobe.xmp") {
  const chunkType = encoder.encode('iTXt');

  /* iTXT Chunk data format:
     Keyword:             1-79 bytes (character string)
     Null separator:      1 byte
     Compression flag:    1 byte
     Compression method:  1 byte
     Language tag:        0 or more bytes (character string)
     Null separator:      1 byte
     Translated keyword:  0 or more bytes
     Null separator:      1 byte
     Text:                0 or more bytes
  */

  // Define and populate the data fields for the chunk
  const fields = new Map();

  // Null terminated encoded keyword
  fields.set("keyword", encoder.encode(`${keyword}\0`));

  // Uncompressed
  fields.set("compressionFlag", new Uint8Array([0]));

  // Compression method 0: zlib is the only compression method
  fields. set("compressionMethod", new Uint8Array([0]));

  // Null-terminated language tag e.g. "en"
  // TODO: Adding the language tag (e.g "en") here borks the chunk/offsets/lengths?
  fields.set("languageTag", encoder.encode(`\0`));

  // Translated keyword: Null-terminated translated keyword
  fields.set("translatedKeyword", encoder.encode('\0'));

  // Text data e.g. XMP metadata (UTF-8 encoded)
  fields.set("textData", encoder.encode(text));

  const dataFieldsSize = [...fields.values()].reduce((sum, part) => sum + part.length, 0);

  // Combine all fields into the chunk data block
  const dataBlock = new Uint8Array(dataFieldsSize);

  // Combine all the data fields into a data block
  let offset = 0;
  for (let part of [...fields.values()]) {
    dataBlock.set(part, offset);
    offset += part.length;
  }

  // Calculate CRC
  const crcData = new Uint8Array(chunkType.length + dataBlock.length);
  crcData.set(chunkType, 0);
  crcData.set(dataBlock, chunkType.length);
  const crc = uint32ToBytes(computeCrc(crcData));

  // Combine all parts into the final chunk
  offset = 0;
  const chunkLength = uint32ToBytes(dataBlock.length);
  const chunkParts = [
    chunkLength,
    chunkType,
    dataBlock,
    crc
  ];
  const bytesCount = chunkParts.reduce((sum, part) => sum + part.length, 0);

  const chunk = new Uint8Array(bytesCount);
  for (let part of chunkParts) {
    chunk.set(part, offset);
    offset += part.length;
  }
  return chunk;
}

/*
 * Unpack the PNG chunk at the given index into its main parts
 *
 * @param {ArrayBuffer} imgBuffer
 *   A buffer representing the binary the PNG image data
 * @param {Number} offset
 *   The byte offset of the chunk we want
 * @returns {Object}
*/
export function getChunkAtIndex(imgBuffer, offset) {
  // First 4 bytes (0-3) are the chunk length
  // A 4-byte unsigned integer giving the number of bytes in the chunk's data field.
  // The length is the data field +  chunk type code + CRC.
  let lengthView = new DataView(imgBuffer, offset, 4);
  let dataLength = lengthView.getUint32(0);

  // Next 4 bytes (4-7) are the encoded type
  // A 4-byte chunk type code
  const chunkTypeBytes = new Uint8Array(imgBuffer, offset+4, 4);
  const chunkType = decoder.decode(chunkTypeBytes);
  const dataPartOffsets = [
    offset + 4 + 4,
    offset + 4 + 4 + dataLength,
  ];
  const chunkObject = {
    startIndex: offset,
    chunkType,
    dataLength,
    dataPartOffsets,
    chunkDataView: new DataView(imgBuffer, dataPartOffsets[0], dataLength),
    nextIndex: dataPartOffsets[1] + 4, // 4 bytes for the CRC
  }
  if (chunkType == "iTXt") {
    chunkObject.decodedData = decoder.decode(new Uint8Array(imgBuffer, dataPartOffsets[0], dataLength));
  }
  return chunkObject;
}

/*
 * Get chunks from a PNG ArrayBuffer
 *
 * @param {ArrayBuffer} imgBuffer
 *   The binary data that is the PNG image data
 * @param {Function} matchFn
 *   An optional matchFn used to identify the first chunk. E.g first of a particular type.
 *   If the matchFn is given, only the matched chunk will be returned
 * @returns {Map} chunk objects keyed by their offset into the buffer, each with type, offsets etc.
*/
export function getChunksFromPNGArrayBuffer(imgBuffer, handleChunk) {
  let offset = 8; // for the signature
  let len = imgBuffer.byteLength;
  let chunks = new Map();
  //console.log("imgBuffer", imgBuffer);
  //console.log(`getChunksFromPNGArrayBuffer, offset: ${offset}, len: ${len}`);

  while(!isNaN(offset) && offset < len) {
    let chunk = getChunkAtIndex(imgBuffer, offset);
    // the offset of the next chunk is 4 (length) + 4 (type) + chunkLength + 4 (CRC)
    chunks.set(offset, chunk);
    //console.log(`getChunksFromPNGArrayBuffer, offset: ${offset}, len: ${len}`,chunk);
    const shouldContinue = handleChunk(chunk);
    if (!shouldContinue) {
      break;
    }
    offset = chunk.nextIndex;
  }
  return chunks;
}

/*
 * Get an XML Document representing the text data from an already-decoded iTXtData chunk
 *
 * @param {String} decodedData
 * @returns {(XMLDocument|null)} The parsed XMP document or null if parsing failed
*/
function getXMPDocumentFromITxTData(decodedData) {
  function findParts(str, [startStr,qualifierStr,endStr]) {
    if (!endStr) {
      endStr = qualifierStr;
      qualifierStr = null;
    }
    let startIndex = str.indexOf(startStr);
    if (startIndex < 0) {
      throw new Error("Didnt find the ?xpacket marker");
    }
    let endIndex = str.substring(startIndex).indexOf(endStr);
    if (endIndex < 0) {
      throw new Error("Didnt find the ?xpacket marker close");
    }
    endIndex += startIndex + endStr.length;
    if (qualifierStr && str.substring(startIndex, endIndex).indexOf(qualifierStr) < 0) {
      startIndex = endIndex = -1;
    }
    return {
      start: startIndex,
      end: endIndex,
    };
  }
  let remainder = decodedData;
  let xmlDocument;
  let beginMarkerOffsets, endMarkerOffsets;

  try {
    beginMarkerOffsets = findParts(remainder, ["<?xpacket", "begin", "?>"]);
  } catch (ex) {
    console.warn(ex);
  }
  if (beginMarkerOffsets.start < 0 || beginMarkerOffsets.end <= beginMarkerOffsets.start) {
    console.warn("Didn't find the begin marker");
    return null;
  }
  remainder = remainder.substring(beginMarkerOffsets.end);

  try {
    endMarkerOffsets = findParts(remainder, ["<?xpacket", "end", "?>"]);
  } catch (ex) {
    console.warn(ex);
  }
  if (endMarkerOffsets.start < 0 || endMarkerOffsets.end <= endMarkerOffsets.start) {
    console.warn("Didn't find the end marker");
    return null;
  }
  remainder = remainder.substring(0, endMarkerOffsets.start);
  if (!xmlParser) {
    xmlParser = new DOMParser();
  }
  try {
    xmlDocument = xmlParser.parseFromString(remainder, "application/xml");
  } catch (ex) {
    console.warn("Failed to parse XML string:", remainder, ex);
    throw new Error(ex.message)
  }
  const metadata = {
    // <rdf:Description rdf:about=".."  >
    resourceUrl: xmlDocument.querySelector("Description")?.getAttribute("rdf:about"),
    // <dc:title> <rdf:li>...
    title: xmlDocument.querySelector("title li")?.textContent,
    // <rdf:Description> <dc:description> <rdf:li>...
    description: xmlDocument.querySelector("Description > description li")?.textContent,
  };
  return metadata;
}

/*
 * Extract the XMP metadata from a PNG ArrayBuffer.
 *
 * @param {ArrayBuffer} imgBuffer
 *   The binary data that is the PNG image data
 * @returns {Object}
*/
export async function getImageMetadata(imgBuffer) {
  const metadata = {};
  const chunksByIndex = getChunksFromPNGArrayBuffer(imgBuffer, function handleChunk(chunk) {
    let shouldContinue = true;
    console.log("getImageMetadata, type:", chunk.chunkType);
    if (chunk.chunkType == "iTXt") {
      // To further parse the text data, we need to know what kind of stuff is in there.
      // which is indicated by the initial `keyword` field
      const keyword = chunk.decodedData.split("\0")[0];
      console.log("getImageMetadata, keyword:", keyword, chunk);
      switch (keyword) {
        case "XML:com.adobe.xmp":
          // extract properties from the XMP data
          let result = getXMPDocumentFromITxTData(chunk.decodedData);
          if (result) {
            Object.assign(metadata, result);
          }
          break;
        default:
          // do nothing for now
      }
    } else if (chunk.chunkType == "IDAT") {
      shouldContinue = false;
    }
    return shouldContinue;
  });
  return metadata;
}


/*
 * Insert a byte array into a buffer at a given offset
 *
 * @param {Uint8Array} byteArray
 *   The binary data to insert as an array of 8-bit unsigned integers
 * @param {ArrayBuffer} targetBuffer
 *   A buffer representing the binary data we want to insert the new data into
 * @param {Number} offset
 *   The byte offset into the target to insert the byteArray at
 * @returns {ArrayBuffer}
*/
function insertBytes(byteArray, targetBuffer, offset) {
  var targetArray = new Uint8Array(targetBuffer);
  console.log("insertBytes, targetBuffer:", targetBuffer, targetBuffer instanceof ArrayBuffer);

  // Check if the offset is within the bounds of the target array
  if (offset < 0 || offset > targetArray.length) {
      throw new Error("Index out of bounds");
  }

  // Create a new ArrayBuffer that is large enough to hold the combined data
  var newBuffer = new ArrayBuffer(targetArray.length + byteArray.length);
  var newArray = new Uint8Array(newBuffer);

  // Copy the original data to the new array up to the offset
  newArray.set(targetArray.subarray(0, offset), 0);

  // Insert the new data
  newArray.set(byteArray, offset);

  // Copy the remaining part of the original data after the inserted data
  newArray.set(targetArray.subarray(offset), offset + byteArray.length);

  return newBuffer;
}

export function insertCustomChunk(imgBuffer, textChunk) {
  let offset = 8; // for the signature
  let len = imgBuffer.byteLength;
  let iHDROffsets = [0,0];

  while(!isNaN(offset) && offset < len) {
    let { nextIndex, chunkType } = getChunkAtIndex(imgBuffer, offset);
    // the offset of the next chunk is 4 (length) + 4 (type) + chunkLength + 4 (CRC)
    if (chunkType == "IHDR") {
      // we'll insert our textChunk right after the IHDR
      iHDROffsets[0] = offset;
      iHDROffsets[1] = nextIndex;
    }
    offset = nextIndex;
  }
  // console.log("IHDR offsets:", iHDROffsets);
  return insertBytes(textChunk, imgBuffer, iHDROffsets[1]);
}

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

function updateCrc(crc, buf, len) {
  let c = crc;
  let n = 0;

  for (n = 0; n < len; n++) {
    c = crcTable[(c ^ buf[n]) & 0xff] ^ (c >> 8);
  }
  return c;
}

/* Return the CRC of the bytes buf[0..len-1]. */
function computeCrc(buf) {
  if (!crcTableComputed) {
    makeCrcTable();
  }
  return updateCrc(0xffffffff, buf, buf.length) ^ 0xffffffff;
}
