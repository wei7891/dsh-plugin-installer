/**
 * 冒烟测试用的 @deepseek-ai/dsh-tools 桩模块。
 *
 * 真实包只在 DSH 运行时内可用（不发布到 npm），冒烟测试只需要
 * defineTool 透传工具定义即可验证「插件能加载、能注册 4 个工具」。
 */
export function defineTool(tool) {
  return tool
}
