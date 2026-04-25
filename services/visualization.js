/**
 * Menghasilkan URL gambar dari kode LaTeX menggunakan CodeCogs
 * @param {string} latex - Persamaan LaTeX (contoh: "E=mc^2")
 * @returns {string} URL gambar PNG
 */
function generateLatexUrl(latex) {
    const encoded = encodeURIComponent(latex);
    return `https://latex.codecogs.com/png.latex?\\dpi{150}&space;${encoded}`;
}

/**
 * Menghasilkan URL gambar dari konfigurasi Chart.js menggunakan QuickChart
 * @param {object} chartConfig - Konfigurasi Chart.js (type, data, options)
 * @returns {string} URL gambar PNG
 */
function generateChartUrl(chartConfig) {
    const json = JSON.stringify(chartConfig);
    const encoded = encodeURIComponent(json);
    return `https://quickchart.io/chart?c=${encoded}&w=500&h=300`;
}

module.exports = { generateLatexUrl, generateChartUrl };
