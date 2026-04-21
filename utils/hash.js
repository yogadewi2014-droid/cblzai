const crypto = require('crypto');

function md5Hash(input) {
    return crypto.createHash('md5').update(input).digest('hex');
}

function sha256Hash(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

module.exports = { md5Hash, sha256Hash };
