/**
 * Router klasifikasi soal matematika Yenni.
 * Digunakan untuk memilih strategi pemrosesan yang paling efisien:
 * - Simple   → evaluasi langsung (tanpa API)
 * - Medium   → Gemini 2.0 Flash Lite (murah & cepat)
 * - Hard     → DeepSeek Reasoning (akurat)
 */

/**
 * Soal aritmatika murni yang aman dihitung dengan eval sederhana.
 * Hanya mengizinkan angka, operator dasar, titik, spasi, dan tanda kurung.
 * Panjang dibatasi agar tidak mengeksekusi ekspresi raksasa.
 */
function isSimpleMath(input) {
    if (!input || input.length > 100) return false;
    // Hanya izinkan karakter: 0-9, +, -, *, /, ( , ) , . , spasi
    return /^[0-9+\-*/().\s]+$/.test(input);
}

/**
 * Soal matematika menengah yang masih nyaman dikerjakan Gemini.
 * Meliputi: geometri, aljabar dasar, aritmatika sosial, statistika deskriptif.
 */
function isMediumMath(input) {
    if (!input) return false;
    const lower = input.toLowerCase();
    const patterns = [
        // Geometri
        /luas/i,
        /keliling/i,
        /volume/i,
        /diagonal/i,
        /sisi/i,
        /sudut/i,
        /segitiga/i,
        /lingkaran/i,
        /jari-jari/i,
        /diameter/i,

        // Aljabar dasar
        /persamaan/i,
        /pertidaksamaan/i,
        /fungsi/i,
        /gradien/i,
        /akar\s*(kuadrat|pangkat)?/i,
        /pangkat/i,
        /faktorisasi/i,
        /bentuk\s*aljabar/i,

        // Aritmatika & bilangan
        /kpk/i,
        /fpb/i,
        /kelipatan/i,
        /faktor\s*(persekutuan)?/i,
        /pecahan/i,
        /desimal/i,
        /persen/i,
        /perbandingan/i,
        /skala/i,

        // Statistika & data
        /rata-rata/i,
        /mean/i,
        /median/i,
        /modus/i,
        /diagram\s*(batang|lingkaran|garis)/i,
        /tabel\s*frekuensi/i,

        // Trigonometri & pengukuran
        /trigonometri/i,
        /sinus|cosinus|tangen/i,
        /derajat/i,
        /radian/i,
        /konversi\s*satuan/i,

        // Peluang & logika dasar
        /peluang/i,
        /ruang\s*sampel/i,
        /titik\s*sampel/i,
    ];
    return patterns.some(p => p.test(lower));
}

/**
 * Soal yang membutuhkan reasoning berat (DeepSeek).
 * Soal cerita kompleks, pembuktian, kalkulus, koding, dll.
 */
function isHardReasoning(input) {
    if (!input) return false;
    const lower = input.toLowerCase();
    const patterns = [
        // Soal cerita kompleks (indikator konteks naratif)
        /soal\s*cerita/i,
        /sebuah\s*.*(berjalan|bergerak|mengalir)/i,
        /dari\s*kota\s*\w+\s*ke\s*kota/i,
        /seorang\s*(pedagang|petani|pengusaha)/i,
        /dalam\s*sebuah\s*(kelas|kandang|toko)/i,
        /harga\s*.*dan\s*harga/i,
        /jika\s*.*maka\s*.*berapa/i,

        // Kalkulus & analisis
        /turunan/i,
        /diferensial/i,
        /integral/i,
        /limit\s*(fungsi)?/i,
        /kalkulus/i,

        // Pembuktian & logika matematika
        /buktikan/i,
        /analisis/i,
        /logika\s*matematika/i,
        /induksi\s*matematika/i,

        // Pemrograman & algoritma
        /program/i,
        /algoritma/i,
        /coding/i,
        /pseudocode/i,
        /sintaks/i,
        /bahasa\s*pemrograman/i,
        /python|javascript|java|c\+\+/i,

        // Optimasi & pemodelan
        /optimasi/i,
        /maksimum|minimum/i,
        /pemrograman\s*linear/i,
        /simpleks/i,

        // Bunga, anuitas, keuangan
        /bunga\s*majemuk/i,
        /anuitas/i,
        /depresiasi/i,
        /investasi/i,
        /saham/i,
        /obligasi/i,
    ];
    return patterns.some(p => p.test(lower));
}

module.exports = { isSimpleMath, isMediumMath, isHardReasoning };
