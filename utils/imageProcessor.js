const sharp = require('sharp');
const pdfParse = require('pdf-parse');
const logger = require('./logger');

/**
 * Kompres gambar sebelum OCR
 * @param {Buffer} inputBuffer - Buffer gambar asli
 * @param {Object} options - Opsi kompresi
 * @param {number} options.maxWidth - Lebar maksimal (default 1024)
 * @param {number} options.quality - Kualitas JPEG 0-100 (default 80)
 * @returns {Promise<Buffer>} Buffer gambar terkompresi
 */
async function compressImage(inputBuffer, options = {}) {
    const maxWidth = options.maxWidth || 1024;
    const quality = options.quality || 80;

    try {
        const compressedBuffer = await sharp(inputBuffer)
            .resize({ width: maxWidth, withoutEnlargement: true })
            .jpeg({ quality: quality })
            .toBuffer();

        logger.info(`Image compressed: ${inputBuffer.length} -> ${compressedBuffer.length} bytes`);
        return compressedBuffer;
    } catch (error) {
        logger.warn('Image compression failed, using original:', error.message);
        return inputBuffer; // Fallback ke gambar asli
    }
}

/**
 * Ekstrak teks dari PDF (menggunakan pdf-parse untuk PDF berbasis teks)
 * @param {Buffer} pdfBuffer - Buffer file PDF
 * @returns {Promise<string>} Teks hasil ekstraksi
 */
async function extractTextFromPDF(pdfBuffer) {
    try {
        const data = await pdfParse(pdfBuffer);
        const text = data.text.trim();
        if (text.length > 0) {
            logger.info(`PDF text extracted: ${text.length} characters`);
            return text;
        }
        logger.warn('PDF appears to be a scan (no text found)');
        return null; // PDF hasil scan, tidak ada teks
    } catch (error) {
        logger.error('PDF extraction failed:', error);
        throw new Error('PDF_EXTRACT_FAILED: ' + error.message);
    }
}

module.exports = { compressImage, extractTextFromPDF };
