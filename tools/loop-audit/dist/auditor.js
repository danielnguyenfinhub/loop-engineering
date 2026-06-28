import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
const STATE_FILES = [
    'STATE.md',
    'pr-babysitter-state.md',
    'ci-sweeper-state.md',
    'post-merge-state.md',
    'dependency-sweeper-state.md',
    'changelog-drafter-state.md',
    'issue-triage-state.md',
];
/** Score contribution for each readiness signal (see computeScore). */
const SCORE_WEIGHTS = {
    base: 10,
    stateFile: 18,
    triage: 14,
    loopConfig: 9,
    agentsMd: 9,
    skillsTwoPlus: 14,
    skillsOne: 7,
    verifier: 14,
    safetyLoopMd: 4,
    safetyDoc: 4,
    github: 6,
    githubWorkflows: 4,
    mcp: 3,
    worktree: 3,
    registry: 2,
    budgetDoc: 3,
    runLog: 3,
    loopMdBudget: 2,
    budgetSkill: 2,
    loopActivity: 6,
    // Genius-tier signals
    circuitBreaker: 5,
    denylistConfig: 4,
    escalationPolicy: 3,
    structuredRunLog: 2,
};
const LEVEL_THRESHOLDS = {
    L1: 38,
    L2: 58,
    L3: 78,
};
const LOOP_SKILL_NAMES = [
    'loop-triage',
    'minimal-fix',
    'loop-verifier',
    'pr-review-triage',
    'ci-triage',
    'post-merge-scan',
    'dependency-triage',
    'rebase-and-clean',
    'changelog-scan',
    'draft-release-notes',
    'issue-triage',
    // Genius-tier skills (blueprint §4)
    'loop-replanner',
    'loop-escalation',
];
const SAFETY_FILES = ['safety.md', 'docs/safety.md', 'SECURITY.md'];
const MCP_FILES = ['.mcp.json', 'mcp.json', '.mcp/config.json'];
const WORKTREE_HINTS = ['worktree', 'worktrees', 'git worktree'];
const BUDGET_HINTS = [/budget/i, /max tokens/i, /token cap/i, /kill switch/i, /loop-pause-all/i];
// Genius-tier detection patterns (blueprint §4)
const CIRCUIT_BREAKER_HINTS = [
    /max.?iterations?/i, /max.?attempts?/i, /circuit.?breaker/i, /stall.?detection/i,
    /kill.?switch/i, /loop.?pause/i, /confidence.?decay/i, /min.?progress/i,
];
const DENYLIST_HINTS = [/denylist/i, /deny.?list/i, /never.?edit/i, /\.env/i, /auth\//i, /payments\//i];
const ESCALATION_HINTS = [/escalat/i, /human.?gate/i, /notify.?human/i, /human.?inbox/i, /batch.?question/i];
const STRUCTURED_LOG_HINTS = [/"run_id"/i, /"pattern"/i, /"outcome"/i, /"tokens_estimate"/i];
async function fileExists(p) {
    try {
        await stat(p);
        return true;
    }
    catch {
        return false;
    }
}
async function findSkills(root) {
    const dirs = [
        path.join(root, '.grok', 'skills'),
        path.join(root, '.claude', 'skills'),
        path.join(root, '.codex', 'skills'),
        path.join(root, 'skills'),
    ];
    const found = [];
    for (const dir of dirs) {
        if (!(await fileExists(dir)))
            continue;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory())
                found.push(e.name);
            if (e.isFile() && e.name === 'SKILL.md')
                found.push('root-skill');
        }
    }
    // Claude Code agents and Codex subagents can host the verifier role
    const agentDirs = [
        path.join(root, '.claude', 'agents'),
        path.join(root, '.codex', 'agents'),
    ];
    for (const dir of agentDirs) {
        if (!(await fileExists(dir)))
            continue;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isFile())
                continue;
            const base = e.name.replace(/\.(md|toml)$/i, '');
            if (base.includes('verifier') || base === 'loop-verifier') {
                found.push('loop-verifier');
            }
        }
    }
    return found;
}
async function detectLoopActivity(root) {
    const evidence = [];
    const stateCandidates = [...STATE_FILES, 'STATE.md'];
    // 1. Look for "Last run" timestamps or dated entries inside state files (strong real-usage signal)
    for (const sf of stateCandidates) {
        try {
            const p = path.join(root, sf);
            if (await fileExists(p)) {
                const txt = await readFile(p, 'utf8');
                if (/last\s*run|last updated|^\s*-\s*\d{4}-\d{2}-\d{2}/im.test(txt) || /triage|loop run|changelog drafter/i.test(txt)) {
                    evidence.push(`state:${sf}`);
                }
            }
        }
        catch { }
    }
    // 2. Presence of run log artifacts or dedicated log templates being used
    const logHints = ['loop-run-log', 'run-log', 'loop.log', 'audit-report'];
    try {
        const entries = await readdir(root, { withFileTypes: true });
        for (const e of entries) {
            if (e.isFile() && logHints.some(h => e.name.toLowerCase().includes(h))) {
                evidence.push(`log:${e.name}`);
            }
        }
    }
    catch { }
    // 3. Workflow or LOOP evidence of scheduled execution
    try {
        const wfDir = path.join(root, '.github', 'workflows');
        if (await fileExists(wfDir)) {
            const wfs = await readdir(wfDir);
            if (wfs.some(w => /triage|changelog|daily|loop|audit|pr-babysit/i.test(w))) {
                evidence.push('github:loop-workflows');
            }
        }
    }
    catch { }
    // 4. Light git history scan for loop-related commits (best dynamic proof)
    try {
        const log = execSync('git log --oneline -25 -- .', {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1500,
        });
        const lower = log.toLowerCase();
        if (/state\.md|loop|triage|changelog-drafter|post-merge|daily triage|audit/i.test(lower)) {
            const firstMatch = log.trim().split('\n')[0] || '';
            evidence.push(`git:${firstMatch.slice(0, 60)}`);
        }
    }
    catch {
        // git not available or not a repo — ignore gracefully
    }
    // 5. Check LOOP.md or a state for explicit "Last run" human-readable proof
    try {
        const loopP = path.join(root, 'LOOP.md');
        if (await fileExists(loopP)) {
            const txt = await readFile(loopP, 'utf8');
            if (/last run|cadence|scheduled|automation/i.test(txt))
                evidence.push('LOOP.md:active');
        }
    }
    catch { }
    return { present: evidence.length > 0, evidence: Array.from(new Set(evidence)).slice(0, 4) };
}
export function computeScore(signals) {
    const w = SCORE_WEIGHTS;
    let score = w.base;
    if (signals.stateFile.present)
        score += w.stateFile;
    if (signals.triage.present)
        score += w.triage;
    if (signals.loopConfig.present)
        score += w.loopConfig;
    if (signals.agentsMd.present)
        score += w.agentsMd;
    if (signals.skills.count >= 2)
        score += w.skillsTwoPlus;
    else if (signals.skills.count === 1)
        score += w.skillsOne;
    if (signals.verifier.present)
        score += w.verifier;
    if (signals.safety.loopMdMentionsSafety)
        score += w.safetyLoopMd;
    if (signals.safety.safetyDocPresent)
        score += w.safetyDoc;
    if (signals.github.present)
        score += w.github;
    if (signals.github.workflows)
        score += w.githubWorkflows;
    if (signals.mcp.present)
        score += w.mcp;
    if (signals.worktreeEvidence.present)
        score += w.worktree;
    if (signals.registry.present)
        score += w.registry;
    if (signals.cost.budgetDoc)
        score += w.budgetDoc;
    if (signals.cost.runLog)
        score += w.runLog;
    if (signals.cost.loopMdBudget)
        score += w.loopMdBudget;
    if (signals.cost.budgetSkill)
        score += w.budgetSkill;
    if (signals.loopActivity.present)
        score += w.loopActivity;
    if (signals.circuitBreaker.present)
        score += w.circuitBreaker;
    if (signals.denylistConfig.present)
        score += w.denylistConfig;
    if (signals.escalationPolicy.present)
        score += w.escalationPolicy;
    if (signals.structuredRunLog.present)
        score += w.structuredRunLog;
    score = Math.min(100, Math.max(0, score));
    const costReady = signals.cost.budgetDoc &&
        signals.cost.runLog &&
        signals.cost.loopMdBudget;
    const hasRealActivity = signals.loopActivity.present;
    const l3Ready = costReady && hasRealActivity;
    let level = 'L0';
    if (score >= LEVEL_THRESHOLDS.L3 && signals.verifier.present && signals.stateFile.present && l3Ready)
        level = 'L3';
    else if (score >= LEVEL_THRESHOLDS.L2 && signals.triage.present)
        level = 'L2';
    else if (score >= LEVEL_THRESHOLDS.L1 && signals.stateFile.present)
        level = 'L1';
    else
        level = 'L0';
    const hasGeniusTier = signals.circuitBreaker.present && signals.denylistConfig.present && signals.escalationPolicy.present;
    const assessment = score >= 82 && l3Ready && hasGeniusTier
        ? 'Genius-tier loop readiness — circuit breakers, denylist, and escalation protocol present. Production-grade unattended operation possible.'
        : score >= 82 && l3Ready && !hasGeniusTier
            ? 'Strong loop readiness (L3 capable) — add circuit breakers, denylist config, and escalation policy for genius-tier operation.'
            : score >= 82 && !costReady
                ? 'Strong signals but missing cost observability (loop-budget.md, loop-run-log.md, LOOP.md budget) — add before L3.'
                : score >= 82 && !hasRealActivity
                    ? 'Strong structure but no proven loop runs yet — run one L1 cycle and commit state before L3.'
                    : score >= 62
                        ? 'Good foundation — add missing verifier + safety docs for L3.'
                        : score >= 42
                            ? 'Early loop setup — focus on L1 state + triage before enabling actions.'
                            : 'Not loop-ready — start with a starter from this repo (minimal-loop or pr-babysitter).';
    return { score, level, assessment };
}
export async function auditProject(target) {
    const root = path.resolve(target);
    const findings = [];
    const recommendations = [];
    const statePaths = [];
    for (const f of STATE_FILES) {
        if (await fileExists(path.join(root, f)))
            statePaths.push(f);
    }
    const loopMd = await fileExists(path.join(root, 'LOOP.md'));
    const agentsMd = await fileExists(path.join(root, 'AGENTS.md')) ||
        await fileExists(path.join(root, 'CLAUDE.md'));
    const skillNames = await findSkills(root);
    const loopSkills = skillNames.filter((s) => LOOP_SKILL_NAMES.includes(s));
    const verifier = skillNames.includes('loop-verifier');
    const triage = skillNames.includes('loop-triage') ||
        skillNames.includes('pr-review-triage') ||
        skillNames.includes('ci-triage') ||
        skillNames.includes('dependency-triage') ||
        skillNames.includes('post-merge-scan') ||
        skillNames.includes('changelog-scan') ||
        skillNames.includes('issue-triage');
    let loopMdContent = '';
    if (loopMd) {
        loopMdContent = await readFile(path.join(root, 'LOOP.md'), 'utf8');
    }
    // New expanded signals
    const githubDir = await fileExists(path.join(root, '.github'));
    const hasWorkflows = await fileExists(path.join(root, '.github', 'workflows'));
    // Proper safety doc detection
    let safetyDocPresent = false;
    for (const f of SAFETY_FILES) {
        if (await fileExists(path.join(root, f))) {
            safetyDocPresent = true;
            break;
        }
    }
    if (!safetyDocPresent) {
        safetyDocPresent = await fileExists(path.join(root, 'docs', 'safety.md'));
    }
    const mcpPresent = (await Promise.all(MCP_FILES.map(f => fileExists(path.join(root, f))))).some(Boolean) ||
        /MCP|mcp server|plugins & connectors/i.test(loopMdContent);
    // Light evidence of worktree usage (common in patterns/starters/LOOP)
    let worktreeEvidence = false;
    const candidateMd = [
        'LOOP.md',
        'patterns/pr-babysitter.md',
        'starters/minimal-loop/LOOP.md',
        'starters/minimal-loop-claude/LOOP.md',
        'starters/minimal-loop-codex/LOOP.md',
        'docs/operating-loops.md',
    ];
    for (const c of candidateMd) {
        try {
            const p = path.join(root, c);
            if (await fileExists(p)) {
                const txt = await readFile(p, 'utf8');
                if (WORKTREE_HINTS.some(h => txt.toLowerCase().includes(h))) {
                    worktreeEvidence = true;
                    break;
                }
            }
        }
        catch { }
    }
    const registryPresent = await fileExists(path.join(root, 'patterns', 'registry.yaml'));
    const budgetDoc = await fileExists(path.join(root, 'loop-budget.md'));
    const runLog = await fileExists(path.join(root, 'loop-run-log.md'));
    const loopMdBudget = BUDGET_HINTS.some((re) => re.test(loopMdContent));
    const budgetSkillDirs = [
        path.join(root, 'skills', 'loop-budget'),
        path.join(root, '.grok', 'skills', 'loop-budget'),
        path.join(root, '.claude', 'skills', 'loop-budget'),
        path.join(root, '.codex', 'skills', 'loop-budget'),
    ];
    let budgetSkill = false;
    for (const dir of budgetSkillDirs) {
        if (await fileExists(path.join(dir, 'SKILL.md'))) {
            budgetSkill = true;
            break;
        }
    }
    const loopActivity = await detectLoopActivity(root);
    // Genius-tier signal detection (blueprint §4)
    const geniusCandidates = ['LOOP.md', 'STATE.md', 'loop-budget.md', 'AGENTS.md'];
    let circuitBreakerFound = false;
    let denylistFound = false;
    let escalationFound = false;
    let structuredRunLogFound = false;
    for (const f of geniusCandidates) {
        try {
            const p = path.join(root, f);
            if (await fileExists(p)) {
                const txt = await readFile(p, 'utf8');
                if (!circuitBreakerFound && CIRCUIT_BREAKER_HINTS.some((re) => re.test(txt)))
                    circuitBreakerFound = true;
                if (!denylistFound && DENYLIST_HINTS.some((re) => re.test(txt)))
                    denylistFound = true;
                if (!escalationFound && ESCALATION_HINTS.some((re) => re.test(txt)))
                    escalationFound = true;
            }
        }
        catch { }
    }
    // Also search skills content for denylist, circuit breaker, escalation hints
    const skillCandidateDirs = [
        path.join(root, '.grok', 'skills'),
        path.join(root, '.claude', 'skills'),
        path.join(root, '.codex', 'skills'),
        path.join(root, 'skills'),
    ];
    for (const dir of skillCandidateDirs) {
        if (!(await fileExists(dir)))
            continue;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory())
                continue;
            const skillFile = path.join(dir, e.name, 'SKILL.md');
            try {
                if (await fileExists(skillFile)) {
                    const txt = await readFile(skillFile, 'utf8');
                    if (!circuitBreakerFound && CIRCUIT_BREAKER_HINTS.some((re) => re.test(txt)))
                        circuitBreakerFound = true;
                    if (!denylistFound && DENYLIST_HINTS.some((re) => re.test(txt)))
                        denylistFound = true;
                    if (!escalationFound && ESCALATION_HINTS.some((re) => re.test(txt)))
                        escalationFound = true;
                }
            }
            catch { }
        }
    }
    // Structured run log: check if loop-run-log.md contains JSON entries
    try {
        const runLogPath = path.join(root, 'loop-run-log.md');
        if (await fileExists(runLogPath)) {
            const txt = await readFile(runLogPath, 'utf8');
            if (STRUCTURED_LOG_HINTS.some((re) => re.test(txt)))
                structuredRunLogFound = true;
        }
    }
    catch { }
    const signals = {
        stateFile: { present: statePaths.length > 0, paths: statePaths },
        loopConfig: { present: loopMd, path: loopMd ? 'LOOP.md' : undefined },
        skills: { count: loopSkills.length, loopSkills },
        verifier: { present: verifier },
        triage: { present: triage },
        agentsMd: { present: agentsMd },
        patterns: { documented: loopMd },
        safety: { loopMdMentionsSafety: /gate|denylist|auto-merge|safety/i.test(loopMdContent), safetyDocPresent },
        starters: { used: loopSkills.includes('loop-triage') },
        github: { present: githubDir, workflows: hasWorkflows },
        mcp: { present: mcpPresent },
        worktreeEvidence: { present: worktreeEvidence },
        registry: { present: registryPresent },
        cost: { budgetDoc, runLog, loopMdBudget, budgetSkill },
        loopActivity,
        circuitBreaker: { present: circuitBreakerFound },
        denylistConfig: { present: denylistFound },
        escalationPolicy: { present: escalationFound },
        structuredRunLog: { present: structuredRunLogFound },
    };
    if (!signals.stateFile.present) {
        findings.push({ level: 'fail', message: 'No state file (STATE.md or pattern-specific state).' });
        recommendations.push('Copy starters/minimal-loop/STATE.md.example (or -claude / -codex variant) to STATE.md');
    }
    else {
        findings.push({ level: 'ok', message: `State file(s): ${statePaths.join(', ')}` });
    }
    if (!signals.triage.present) {
        findings.push({ level: 'warn', message: 'No triage skill detected.' });
        recommendations.push('Install loop-triage from starters/minimal-loop, minimal-loop-claude, or minimal-loop-codex');
    }
    else {
        findings.push({ level: 'ok', message: 'Triage skill present.' });
    }
    if (!signals.verifier.present) {
        findings.push({ level: 'warn', message: 'No loop-verifier skill — maker/checker split incomplete.' });
        recommendations.push('Add verifier: .grok/skills/loop-verifier, .claude/agents/loop-verifier.md, or .codex/agents/verifier.toml');
    }
    else {
        findings.push({ level: 'ok', message: 'Verifier skill present.' });
    }
    if (!signals.loopConfig.present) {
        findings.push({ level: 'warn', message: 'No LOOP.md documenting cadence, limits, and gates.' });
        recommendations.push('Copy starters/minimal-loop/LOOP.md and customize');
    }
    if (!signals.agentsMd.present) {
        findings.push({ level: 'warn', message: 'No AGENTS.md / CLAUDE.md for project conventions.' });
        recommendations.push('Add AGENTS.md with build/test commands and review norms');
    }
    if (!signals.safety.loopMdMentionsSafety) {
        findings.push({ level: 'warn', message: 'LOOP.md does not mention safety gates or auto-merge policy.' });
        recommendations.push('Document human gates per docs/safety.md in LOOP.md');
    }
    if (!signals.safety.safetyDocPresent) {
        findings.push({ level: 'warn', message: 'No safety.md or docs/safety.md found.' });
        recommendations.push('Copy or create docs/safety.md (denylists, auto-merge policy, MCP scopes)');
    }
    else {
        findings.push({ level: 'ok', message: 'Safety documentation present.' });
    }
    if (!signals.github.present) {
        findings.push({ level: 'warn', message: 'No .github/ directory (templates, workflows for dogfooding).' });
        recommendations.push('Add .github/ISSUE_TEMPLATE, PULL_REQUEST_TEMPLATE, and workflows (see this repo for examples)');
    }
    else if (!signals.github.workflows) {
        findings.push({ level: 'warn', message: '.github/ exists but no workflows/ (CI dogfood opportunity).' });
        recommendations.push('Add GitHub Actions that run loop-audit and validate patterns (dogfood the reference)');
    }
    else {
        findings.push({ level: 'ok', message: '.github/ with workflows present (strong dogfooding signal).' });
    }
    if (!signals.mcp.present) {
        findings.push({ level: 'warn', message: 'No MCP / connector config or mentions detected.' });
        recommendations.push('Document MCP usage (or note "MCP not required for this pattern") in LOOP.md or skills');
    }
    if (!signals.worktreeEvidence.present) {
        findings.push({ level: 'warn', message: 'Little evidence of worktree usage in docs or state.' });
        recommendations.push('Add worktree isolation notes to LOOP.md or pattern docs (see primitives and starters)');
    }
    if (!signals.registry.present) {
        findings.push({ level: 'warn', message: 'No patterns/registry.yaml (machine-readable index for future tools).' });
        recommendations.push('Add patterns/registry.yaml following the existing format');
    }
    if (!signals.cost.budgetDoc) {
        findings.push({ level: 'warn', message: 'No loop-budget.md — token caps and kill switch undocumented.' });
        recommendations.push('Scaffold with loop-init or copy templates/loop-budget.md.template');
    }
    else {
        findings.push({ level: 'ok', message: 'loop-budget.md present.' });
    }
    if (!signals.cost.runLog) {
        findings.push({ level: 'warn', message: 'No loop-run-log.md — run history not persisted.' });
        recommendations.push('Copy templates/loop-run-log.md.template to loop-run-log.md');
    }
    else {
        findings.push({ level: 'ok', message: 'loop-run-log.md present.' });
    }
    if (!signals.cost.loopMdBudget) {
        findings.push({ level: 'warn', message: 'LOOP.md does not mention budget, token caps, or kill switch.' });
        recommendations.push('Add a Budget section to LOOP.md (see starters/*/LOOP.md)');
    }
    if (!signals.cost.budgetSkill) {
        findings.push({ level: 'warn', message: 'No loop-budget skill — budget checks are not automated at runtime.' });
        recommendations.push('Add loop-budget skill via loop-init or templates/SKILL.md.loop-budget');
    }
    else {
        findings.push({ level: 'ok', message: 'loop-budget skill present.' });
    }
    if (!signals.loopActivity.present) {
        findings.push({ level: 'warn', message: 'No evidence of actual loop runs detected (no "Last run" entries in state, loop-related git activity, or scheduled workflows yet).' });
        recommendations.push('Run one loop (report-only), update + commit STATE.md (or pattern state). This turns structure into proven usage.');
    }
    else {
        findings.push({ level: 'ok', message: `Loop activity detected — real usage signals present (${signals.loopActivity.evidence.length} sources).` });
    }
    // Genius-tier findings (blueprint §4 — Self-Monitoring & Safety)
    if (!signals.circuitBreaker.present) {
        findings.push({ level: 'warn', message: 'No circuit breaker config detected — max attempts, stall detection, and kill switch undocumented.' });
        recommendations.push('Add circuit breaker rules to LOOP.md: max_iterations, max_attempts (hard cap 3), kill switch label, and stall threshold');
    }
    else {
        findings.push({ level: 'ok', message: 'Circuit breaker / safety limits documented.' });
    }
    if (!signals.denylistConfig.present) {
        findings.push({ level: 'warn', message: 'No denylist paths found — loop may modify secrets, auth, or payments without a guard.' });
        recommendations.push('Add denylist section to LOOP.md or skills: .env, auth/, payments/, *_key*, *_secret*, migrations/');
    }
    else {
        findings.push({ level: 'ok', message: 'Denylist path configuration present.' });
    }
    if (!signals.escalationPolicy.present) {
        findings.push({ level: 'warn', message: 'No escalation policy detected — loop may grind silently when blocked.' });
        recommendations.push('Document escalation triggers in LOOP.md (max attempts, ambiguity, denylist touch) and add the loop-escalation skill');
    }
    else {
        findings.push({ level: 'ok', message: 'Escalation policy documented.' });
    }
    if (!signals.structuredRunLog.present && runLog) {
        findings.push({ level: 'warn', message: 'loop-run-log.md exists but no structured JSON entries detected — debugging multi-iteration runs is harder.' });
        recommendations.push('Follow the run log format in templates/loop-run-log.md.template: JSON entries with run_id, pattern, outcome, tokens_estimate');
    }
    else if (signals.structuredRunLog.present) {
        findings.push({ level: 'ok', message: 'Structured JSON run log present — iteration debugging enabled.' });
    }
    const { score, level, assessment } = computeScore(signals);
    const costReady = signals.cost.budgetDoc &&
        signals.cost.runLog &&
        signals.cost.loopMdBudget;
    if (score >= 78 && signals.verifier.present && signals.stateFile.present && !costReady) {
        findings.push({
            level: 'warn',
            message: 'Score qualifies for L3 but cost observability is incomplete — capped at L2 until budget + run log + LOOP.md budget exist.',
        });
    }
    if (score >= 78 && signals.verifier.present && signals.stateFile.present && costReady && !signals.loopActivity.present) {
        findings.push({
            level: 'warn',
            message: 'Score qualifies for L3 but no proven loop activity yet — capped at L2 until you run and commit at least one loop cycle.',
        });
    }
    return {
        target: root,
        score,
        level,
        assessment,
        signals,
        findings,
        recommendations,
    };
}
