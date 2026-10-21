# 历史Mock导出样例

mock-complete.zip是合成软件验收数据，使用内容版本sh-current-2026-10-19-v3，展示5组10单元、4次Mock消息、问卷、休息、草稿及备注。它不是实际被试结果，也不是当前导出schema模板；当前结构以 [API.md](../API.md) 及新导出的manifest.json为准。

样例使用001合成数据，is_debug=false；000调试会话使用is_debug=true。休息通过测试时钟模拟，真实服务的默认休息仍为180秒。Mock没有真实显示/消失证据，相应时间为空；不能用于证明真机呈现或硬件计时。
