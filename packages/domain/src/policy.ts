/**
 * Engineering topics are decided by the team. Only product intent (scope,
 * priority, acceptance, business trade-offs) should ever interrupt the client.
 *
 * This classifier is deliberately conservative: a product marker wins, because
 * misclassifying a product question as engineering silently decides scope.
 */
const PRODUCT_MARKERS = [
  "产品范围",
  "范围边界",
  "优先级",
  "是否要做",
  "要不要做",
  "商业",
  "预算",
  "验收标准",
  "prd",
  "需求取舍",
  "目标用户",
  "成功标准",
  "交付范围",
  "v1 是否",
  "v2 是否",
];

const ENGINEERING_MARKERS = [
  "seed",
  "测试数据",
  "演示数据",
  "baseurl",
  "base url",
  "预览",
  "端口",
  "token",
  "cookie",
  "凭据",
  "口令",
  "账号",
  "环境变量",
  "env",
  "部署",
  "回滚",
  "重启",
  "进程",
  "浏览器",
  "shell",
  "命令行",
  "代码",
  "分支",
  "合并",
  "commit",
  "revert",
  "review",
  "依赖",
  "扫描",
  "sast",
  "sca",
  "限速",
  "锁定",
  "上传",
  "接口",
  "api",
  "数据库",
  "迁移",
  "测试账号",
  "测试环境",
  "走查执行",
  "谁执行",
  "怎么注入",
  "预览实例",
  "token 处置",
  "撤销 token",
  "吊销 token",
  "健康检查",
  "测试口径",
  "测试结论",
  "测试范围",
  "测试计划",
  "走查",
  "人工走查",
  "点击",
  "复测",
];

export function isEngineeringTopic(text: string): boolean {
  const value = String(text ?? "").toLowerCase();
  if (!value.trim()) return false;
  if (PRODUCT_MARKERS.some((marker) => value.includes(marker.toLowerCase()))) {
    return false;
  }
  return ENGINEERING_MARKERS.some((marker) => value.includes(marker.toLowerCase()));
}
