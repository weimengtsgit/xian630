const TRACKS = {
  business_logic: ['目标识别', '对象识别', '规则提取', '澄清判断', '摘要生成'],
  interface_parsing: ['输入解析', '视图识别', '布局分区', '组件映射', '预览生成'],
  data_capture: ['来源', '连接验证', '样本获取', '字段识别', '契约生成', '流向'],
  production_delivery: ['方案设计', '代码生成', '代码审查', '测试验证', '产品验收', '镜像构建', '部署'],
}

export function WorkbenchTrack({ cardKey, activeLabel = '', failedLabel = '' }) {
  const steps = TRACKS[cardKey] || []
  return (
    <ol className={`cw-track cw-track-${cardKey}`}>
      {steps.map(step => {
        const active = step === activeLabel || activeLabel.includes(step)
        const failed = step === failedLabel || failedLabel.includes(step)
        return (
          <li key={step} className={`${active ? 'is-active' : ''}${failed ? ' is-failed' : ''}`.trim()}>
            <span />
            <em>{step}</em>
          </li>
        )
      })}
    </ol>
  )
}
