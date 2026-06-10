import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const STATE_FILES = [
    'STATE.md',
    'pr-babysitter-state.md',
    'ci-sweeper-state.md',
    'post-merge-state.md',
    'dependency-sweeper-state.md',
    'changelog-drafter-state.md',
];
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
];
const SAFETY_FILES = ['safety.md', 'docs/safety.md', 'SECURITY.md'];
const MCP_FILES = ['.mcp.json', 'mcp.json', '.mcp/config.json'];
const WORKTREE_HINTS = ['worktree', 'worktrees', 'git worktree'];
const BUDGET_HINTS = [/budget/i, /max tokens/i, /token cap/i, /kill switch/i, /loop-pause-all/i];
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
export function computeScore(signals) {
    let score = 10;
    if (signals.stateFile.present)
        score += 18;
    if (signals.triage.present)
        score += 14;
    if (signals.loopConfig.present)
        score += 9;
    if (signals.agentsMd.present)
        score += 9;
    if (signals.skills.count >= 2)
        score += 14;
    else if (signals.skills.count === 1)
        score += 7;
    if (signals.verifier.present)
        score += 14;
    if (signals.safety.loopMdMentionsSafety)
        score += 4;
    if (signals.safety.safetyDocPresent)
        score += 4;
    if (signals.github.present)
        score += 6;
    if (signals.github.workflows)
        score += 4;
    if (signals.mcp.present)
        score += 3;
    if (signals.worktreeEvidence.present)
        score += 3;
    if (signals.registry.present)
        score += 2;
    if (signals.cost.budgetDoc)
        score += 3;
    if (signals.cost.runLog)
        score += 3;
    if (signals.cost.loopMdBudget)
        score += 2;
    if (signals.cost.budgetSkill)
        score += 2;
    score = Math.min(100, Math.max(0, score));
    const costReady = signals.cost.budgetDoc &&
        signals.cost.runLog &&
        signals.cost.loopMdBudget;
    let level = 'L0';
    if (score >= 78 && signals.verifier.present && signals.stateFile.present && costReady)
        level = 'L3';
    else if (score >= 58 && signals.triage.present)
        level = 'L2';
    else if (score >= 38 && signals.stateFile.present)
        level = 'L1';
    else
        level = 'L0';
    const assessment = score >= 82 && costReady
        ? 'Strong loop readiness — good candidate for L3 with explicit gates.'
        : score >= 82 && !costReady
            ? 'Strong signals but missing cost observability (loop-budget.md, loop-run-log.md, LOOP.md budget) — add before L3.'
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
        skillNames.includes('changelog-scan');
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
