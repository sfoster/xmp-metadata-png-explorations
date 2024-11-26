# Adding XMP/RDF metadata to PNG images

- Some browser js to create a iTXt chunk with XMP data and insert it into a PNG file, 
- insertXMP.html is a test page which loads a simple 2x2.png file, and writes some XMP metadata into it. Click the output image to save/download the output. 
- We need to locate the IHDR chunk, and insert the new chunk after it
- My use case is for newly created images, I'm not worried right now about finding existing tags or de-duplicating tags. 


## Status

- Eh. Kinda working. The iterating through the chunks and finding the IHDR chunk seems good. The XML document format should be good. The chunk creation and its various parts - including the data length and CRC - seems good. 
- But the actual XML text data doesnt seem to be encoded correctly or something. I "fixed" the keyword to be "'XML:com.adobe.xmp'". But now exiftool now shows a garbled keyword: `XM Lcomadobexmp                 : <?xpacket...` and nothing at all for `-XMP`. 

## Notes: PNG Images and metadata

### Chunks

A PNG file comprises

- PNG signature (8 bytes)
- Chunks: each chunk has the following parts: 
    1. Length (4 bytes): Specifies the number of bytes in the chunk's data field. It does not include the length of the length, type, or CRC fields.
    2. Chunk Type (4 bytes): A sequence of four bytes that defines the type (like IHDR, IDAT, etc.). This field is critical for identifying the chunk.
    3. Chunk Data (variable length): The actual data of the chunk; its length is specified by the length field.
    4. CRC (4 bytes): A cyclic redundancy check sum that covers the chunk type and chunk data fields, used to verify data integrity.
- Chunk types and sequence (not exhaustive):
  -   IHDR, 
  -   iTXt (tEXT, zTXT) can be anywhere between IHDR and IEND (but not interleaved with the IDAT chunks). 
    - Lets say here so we don't necessarily need to decode the whole file? 
  -   PLTE (palette), 
  -   IDAT, IDAT, IDAT etc. (image data, probably compressed) there are many of these,  
  -   IEND (image end) has no data only zero-length field

### Text chunks for metadata

- Textual data is one of the possible types: iTXt, tEXT, zTXT
- Text gets encoded and assembled into a chunk, using either `tEXT` (textual data), `zTXT` (compressed text), or `iTXT` (international textual data) "chunks". 
- `iTXt` is designed to support internationalized textual data, and we're explicitly putting unicode characters in there with the given language/locale 
  - Specification detailed at http://www.libpng.org/pub/png/spec/1.2/PNG-Chunks.html
    - Keyword:             1-79 bytes (character string, null terminated)
    - Null separator:      1 byte 
    - Compression flag:    1 byte (0 = uncompressed, 1 = compressed)
    - Compression method:  1 byte (0 = zlib, the only supported method?)
    - Language tag:        0 or more bytes (character string). E.g. `en-us`, `en` etc.. 
    - Null separator:      1 byte
    - Translated keyword:  0 or more bytes
    - Null separator:      1 byte
    - Text:                0 or more bytes (UTF-8 encoding of the Unicode character set instead of Latin-1)

### XMP
- XMP is an XML format. So we take a valid XML document string and plop that into a textual data chunk. 
- The XML format for XMP is a bit funky....
```
<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description rdf:about="https://foo.com/"
            xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>
                <rdf:Alt>
                    <rdf:li xml:lang="x-default">The image title</rdf:li>
                </rdf:Alt>
            </dc:title>
            <dc:description>
                <rdf:Alt>
                    <rdf:li xml:lang="x-default">The image description</rdf:li>
                </rdf:Alt>
            </dc:description>
        </rdf:Description>
    </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>
```
- Those `<?xpacket>` tags are delimiters and necessary. The id is a default given by Adobe and can be used as-is
- The keyword we want for this is apparently 'XML:com.adobe.xmp'.
- To inject XMP from a .xml file: 
  - `exiftool '-XMP<=xmp_metadata.xml' image.png`
  - Via https://exiftool.org/forum/index.php?topic=2922.0 
- And then just `exiftool -XMP image.png` to see what it can find in there 
  - `exiftool '-XMP'