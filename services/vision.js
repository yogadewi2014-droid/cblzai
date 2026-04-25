const vision = require('@google-cloud/vision');
const logger = require('../utils/logger');

let client;

function getVisionClient() {
    if (client) return client;

    // Cek apakah environment variable GOOGLE_CREDENTIALS_JSON tersedia
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
        try {
            const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
            client = new vision.ImageAnnotatorClient({ credentials });
            logger.info('Google Vision client initialized from GOOGLE_CREDENTIALS_JSON');
            return client;
        } catch (error) {
            logger.error('Failed to parse GOOGLE_CREDENTIALS_JSON:', error);
        }
    }

    // Fallback ke GOOGLE_APPLICATION_CREDENTIALS (untuk development lokal)
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        client = new vision.ImageAnnotatorClient({ keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS });
        logger.info('Google Vision client initialized from key file');
        return client;
    }

    // Fallback ke default credentials
    client = new vision.ImageAnnotatorClient();
    logger.info('Google Vision client initialized with default credentials');
    return client;
}

async function extractTextFromImage(imageBuffer) {
    try {
        const visionClient = getVisionClient();
        const [result] = await visionClient.textDetection({ image: { content: imageBuffer } });
        const detections = result.textAnnotations;
        if (detections && detections.length > 0) {
            return detections[0].description;
        }
        return '';
    } catch (error) {
        logger.error('Google Vision OCR error:', error);
        throw error;
    }
}

module.exports = { extractTextFromImage };
