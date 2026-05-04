    // === 9. Router pemilihan model (TIER-BASED) ===
    const { routeModel } = require('../services/modelRouter');
    let response;
    try {
        // Simple math tetap dihitung lokal
        if (isSimpleMath(originalMessage)) {
            try {
                const result = Function(`"use strict"; return (${originalMessage})`)();
                response = `✨ Hasil dari \`${originalMessage}\` adalah *${result}*`;
                logger.info('Simple math evaluated locally');
            } catch {
                response = await routeModel(userId, fullPrompt, originalMessage);
            }
        } else {
            response = await routeModel(userId, fullPrompt, originalMessage);
        }
    } catch (error) {
        logger.error('LLM error:', error);
        return { text: '😔 Maaf, ada gangguan teknis. Coba lagi ya, Kak.', images: [] };
    }
