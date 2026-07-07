/** 应用分类 */
export type AppCategory = '态势监测' | '情报分析' | '活动规律' | '智能助手';

/** 应用状态 */
export type AppStatus = '已上架' | '新品' | '热门';

/** 智能应用实体 */
export interface SmartApp {
  /** 唯一标识 */
  id: string;
  /** 应用名称 */
  name: string;
  /** 简短描述 */
  description: string;
  /** 详细描述 */
  longDescription: string;
  /** 图标（emoji） */
  icon: string;
  /** 所属分类 */
  category: AppCategory;
  /** 应用状态 */
  status: AppStatus;
  /** 版本号 */
  version: string;
  /** 上架日期 */
  publishDate: string;
  /** 跳转链接 */
  link: string;
  /** 是否已收藏 */
  favorited: boolean;
  /** 功能特性列表 */
  features: string[];
}

/** 分类筛选选项 */
export interface CategoryFilter {
  key: string;
  label: string;
}
