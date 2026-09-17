// DataSourceAdapter 统一数据提供层：
// 前端只消费 fetchBatch 的标准契约（batch + NormalizedPost），切换数据源不重写前端。
//   - DemoDataSource：本次默认实现，本地确定性演示数据（零外网请求）；
//   - XSearchAdapter / InstagramGraphAdapter：live 预留规格（接口位），未配置凭证时
//     fetchBatch 直接抛出诚实错误，绝不发起网络请求，也绝不回退演示数据伪装真实数据。
// 真实平台域名不出现在任何运行时请求中（演示口径硬约束）。
import { DemoTimeline, DEMO_METADATA, withBatchStats } from '../data/demoDataset';

export const DATA_SOURCE_MODES = {
  demo: { id: 'demo', label: 'demo · 演示数据源', active: true },
  live: {
    id: 'live',
    label: 'live · 真实接口（预留禁用）',
    active: false,
    reservedNote:
      'live 通道为预留能力：X（推特）recent search 属付费层（需 Bearer Token），Instagram Graph API 需 Meta App + IG Business 鉴权；两者还需限流与合规设计。数据接入阶段探测已证实无免鉴权公开通道，当前演示口径未接入。',
  },
};

export class DemoDataSource {
  constructor(referenceMs = Date.now()) {
    this.id = 'demo';
    this.label = '演示数据源（本地内置合成）';
    this.isDemo = true;
    this.metadata = DEMO_METADATA;
    this.timeline = new DemoTimeline(referenceMs);
  }

  buildInitial() {
    const { batches, posts, latestIndex } = this.timeline.buildInitial();
    return {
      batches: batches.map((b) => withBatchStats(b, posts)),
      posts,
      latestIndex,
      metadata: this.metadata,
    };
  }

  // 返回标准契约：{ batch, posts }
  fetchBatch(batchIndex, { retry = false } = {}) {
    const { batch, posts } = this.timeline.generateBatch(batchIndex, { retry });
    return { batch: withBatchStats(batch, posts), posts };
  }
}

// —— live 预留层（仅接口位，未启用） ——

export class XSearchAdapter {
  constructor(config = {}) {
    this.id = 'live-x';
    this.label = 'X（推特）recent search（live 预留）';
    this.isDemo = false;
    this.spec = { endpointPath: '/2/tweets/search/recent', auth: 'OAuth2 Bearer Token（付费层）' };
    this.config = config;
  }

  fetchBatch() {
    throw new Error(
      'X（推特）recent search 通道为 live 预留能力：需付费层 Bearer Token 与合规审批后经服务端网关接入，当前演示口径未启用（不会发起任何网络请求）。'
    );
  }
}

export class InstagramGraphAdapter {
  constructor(config = {}) {
    this.id = 'live-ig';
    this.label = 'Instagram Graph API hashtag search（live 预留）';
    this.isDemo = false;
    this.spec = { endpointPath: 'ig_hashtag_search + top/recent_media', auth: 'Meta App + IG Business 鉴权' };
    this.config = config;
  }

  fetchBatch() {
    throw new Error(
      'Instagram Graph API 通道为 live 预留能力：需 Meta App 凭证 + IG Business 账号鉴权与合规审批后经服务端网关接入，当前演示口径未启用（不会发起任何网络请求）。'
    );
  }
}

export function createDataSource(mode = 'demo') {
  if (mode === 'demo') return new DemoDataSource();
  throw new Error(
    `数据源模式 ${mode} 未启用：${DATA_SOURCE_MODES.live.reservedNote}`
  );
}
