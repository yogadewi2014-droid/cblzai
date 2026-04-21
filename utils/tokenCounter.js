function countTokens(text) {
    // Estimasi kasar: 1 token ≈ 4 karakter untuk bahasa Indonesia/Inggris
    return Math.ceil(text.length / 4);
}

module.exports = { countTokens };
