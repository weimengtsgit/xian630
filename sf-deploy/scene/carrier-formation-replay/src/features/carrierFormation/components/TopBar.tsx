import { Bell, CalendarClock, Database, MapPinned, Settings, UserCircle } from "lucide-react";
import { carrierFormation } from "../data/mockFormation";
import { useFleetStore } from "../useFleetStore";

export function TopBar() {
  const dayIndex = useFleetStore((state) => state.dayIndex);
  const currentDay = carrierFormation.track[dayIndex];

  return (
    <header className="top-bar" aria-label="系统状态栏">
      <nav className="top-menu" aria-label="主菜单">
        <button type="button">复盘</button>
        <button type="button">态势</button>
        <button type="button">导出</button>
      </nav>

      <div className="title-ribbon">
        <span className="ribbon-cap left" />
        <h1>航母编队月度航迹复盘系统</h1>
        <span className="ribbon-cap right" />
      </div>

      <div className="status-cluster">
        <span className="status-item">
          <MapPinned size={15} />
          东海扩展海域
        </span>
        <span className="status-item">
          <CalendarClock size={15} />
          {currentDay.date}
        </span>
        <span className="status-item">{carrierFormation.name}</span>
        <button type="button" title="消息">
          <Bell size={16} />
        </button>
        <button type="button" title="数据">
          <Database size={16} />
        </button>
        <button type="button" title="用户">
          <UserCircle size={17} />
        </button>
        <button type="button" title="设置">
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
}

