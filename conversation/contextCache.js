const { callOpenAI } = require('../services/openai');
const { countTokens } = require('../utils/tokenCounter');
const { getSummary, saveSummary } = require('../services/supabase');
const config = require('../config');

async function manageContext(userId, session, newMessage) {
    let history = session.history || [];
    let persistentSummary = await getSummary(userId);
    
    let tokenCount = countTokens((persistentSummary || '') + JSON.stringify(history) + newMessage);
    
    if (tokenCount > config.summaryThreshold) {
        const summaryPrompt = `Ringkas percakapan berikut menjadi poin penting:\n${JSON.stringify(history.slice(0, -6))}`;
        const summary = await callOpenAI(summaryPrompt, { max_tokens: 500 });
        await saveSummary(userId, summary);
        persistentSummary = summary;
        session.history = history.slice(-6);
        history = session.history;
    }
    
    let context = '';
    if (persistentSummary) {
        context += `Ringkasan percakapan sebelumnya:\n${persistentSummary}\n\n`;
    }
    context += `Percakapan terbaru:\n${history.map(m => `${m.role}: ${m.content}`).join('\n')}`;
    
    if (countTokens(context + newMessage) > config.maxContextTokens) {
        session.history = history.slice(-4);
    }
    
    return context;
}

module.exports = { manageContext };
