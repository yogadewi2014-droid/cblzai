const axios = require('axios');

async function downloadFile(url) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
}

module.exports = { downloadFile };
