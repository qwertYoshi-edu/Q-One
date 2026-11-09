export function parseImportance(text) {
    const match = text.match(/_([1-3])$/);
    return match
        ? { text: text.substring(0, text.length - 2).trim(), importance: parseInt(match[1], 10) }
        : { text: text.trim(), importance: 1 };
}

export function parseText(text, defaultPackId = 'manual_input') {
    const rawChunks = text.trim().split('#').map(p => p.trim()).filter(Boolean);
    const validProblems = [];
    let failedCount = 0;

    rawChunks.forEach((chunk, index) => {
        const parsed = parseProblem(chunk, index, defaultPackId);
        if (parsed) validProblems.push(parsed);
        else failedCount++;
    });

    if (failedCount > 0) {
        alert(`⚠️ 注意: 入力された問題のうち ${failedCount} 件の形式が正しくないためスキップされました。\n記号の使い方（@, # など）を確認してください。`);
    }

    return validProblems;
}

function generateProblemId(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    // 負の数も考慮して16進数化し、文字列長も付加して衝突を軽減
    return (hash >>> 0).toString(16) + '-' + str.length.toString(16);
}

export function parseProblem(pStr, index = 0, defaultPackId = 'manual_input') {
    const { text: coreStr, importance } = parseImportance(pStr);
    let m;
    
    const hashId = generateProblemId(pStr);
    const questionId = `q_${index + 1}_${hashId.slice(0, 6)}`;
    
    // 仕様書準拠: packId + questionId による一意識別と revision 管理
    const baseProblem = { 
        importance, 
        originalString: pStr,
        problemId: hashId,
        questionId: questionId,
        packId: defaultPackId,
        revision: 1
    };

    if (m = coreStr.match(/^\[check\](.*?)\@(.*)$/s)) {
        return { ...baseProblem, type: 'check', largeText: m[1].trim(), smallText: m[2].trim() };
    }

    if (m = coreStr.match(/^\[enter\](.*?)\@(.*)$/s)) {
        return { ...baseProblem, type: 'enter', largeText: m[1].trim(), correctAnswer: m[2].trim() };
    }

    if (m = coreStr.match(/^\[fill\](.*?)\@(.*)$/s)) {
        const text = m[2];
        const answers = [];
        const parts = [];
        let lastIndex = 0;
        for (const fm of text.matchAll(/<([^>]+)>/g)) {
            parts.push(text.substring(lastIndex, fm.index));
            answers.push(fm[1].trim());
            lastIndex = fm.index + fm[0].length;
        }
        parts.push(text.substring(lastIndex));
        return { ...baseProblem, type: 'fill', largeText: m[1].trim(), questionParts: parts, answers };
    }

    if (m = coreStr.match(/^\[select\](.*?)\@(.*?)((?:<[^>]+>|{[^}]+})+)$/s)) {
        const [, largeText, smallText, optionsStr] = m;
        const options = [];
        let correctAnswer = '';
        [...optionsStr.matchAll(/<([^>]+)>|{([^}]+)}/g)].forEach(o => {
            if (o[1]) options.push(o[1].trim());
            else {
                correctAnswer = o[2].trim();
                options.push(correctAnswer);
            }
        });
        return { ...baseProblem, type: 'select', largeText: largeText.trim(), smallText: smallText.trim(), options, correctAnswer };
    }

    return null;
}

export function reconstructProblemString(problem) {
    return problem.originalString;
}
