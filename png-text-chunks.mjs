import { computeCrc, crcLookupTable } from "./crc.mjs";

const encoder = new TextEncoder('utf-8')
const decoder = new TextDecoder();

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

function insertBytes(byteArray, targetBuffer, offset) {
  var targetArray = new Uint8Array(targetBuffer);

  // Check if the offset is within the bounds of the target array
  if (offset < 0 || offset > targetArray.length) {
      throw new Error("Index out of bounds");
  }

  // Create a new ArrayBuffer that is large enough to hold the combined data
  var newBuffer = new ArrayBuffer(targetArray.length + byteArray.length);
  console.log("Creating newBuffer of length:", targetArray.length, targetArray.length + byteArray.length);
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
