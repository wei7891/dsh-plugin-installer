/**
 * 故障诊断引擎：把 npm/pnpm 报错输出解析为中文结论 + 可执行修复动作。
 *
 * 这是「自动解析错误原因、自动尝试修复」的核心：每条规则都是
 *   `正则/关键词` → `中文诊断` → `修复动作`
 * 的三元组，按优先级顺序匹配，命中即返回并可继续叠加多个诊断。
 */
import type { AttemptOutcome, Diagnosis, RepairAction } from './types.js';
/**
 * 主入口：根据一次执行的输出给出中文诊断列表。
 *
 * @param raw 原始的 stderr + stdout 拼接文本
 * @param context 附带上下文（被安装的包名等），用于生成更精确的中文说明
 */
export declare function diagnoseCommandOutput(raw: string, context?: {
    packageName?: string;
    command?: string;
}): Diagnosis[];
/** 汇总一次尝试的诊断与修复动作，供上层写入 AttemptOutcome。 */
export declare function summarizeAttempt(raw: string, context?: {
    packageName?: string;
    command?: string;
}): {
    diagnoses: Diagnosis[];
    repairs: RepairAction[];
};
/** 导出规则总数，便于测试断言「覆盖度」。 */
export declare function diagnosisRuleCount(): number;
/** 构造一条「成功」的诊断（供自检阶段使用）。 */
export declare function successDiagnosis(message: string): Diagnosis;
/** 构造一条「需人工确认」的诊断（自检/修复上限用）。 */
export declare function manualInterventionDiagnosis(reason: string, attempts: AttemptOutcome[]): Diagnosis;
//# sourceMappingURL=diagnose.d.ts.map