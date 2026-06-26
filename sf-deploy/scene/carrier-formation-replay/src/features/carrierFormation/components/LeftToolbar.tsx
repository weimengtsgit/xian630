import {
  Anchor,
  CalendarClock,
  Layers3,
  Pause,
  Play,
  Radar,
  Route,
  Shield,
  Target,
} from "lucide-react";
import { useFleetStore } from "../useFleetStore";

const tools = [
  { label: "编队", icon: Anchor },
  { label: "播放", icon: Play },
  { label: "航迹", icon: Route },
  { label: "事件", icon: CalendarClock },
  { label: "图层", icon: Layers3 },
  { label: "警戒", icon: Shield },
  { label: "目标", icon: Target },
  { label: "雷达", icon: Radar },
];

export function LeftToolbar() {
  const isPlaying = useFleetStore((state) => state.isPlaying);
  const togglePlaying = useFleetStore((state) => state.togglePlaying);

  return (
    <aside className="left-toolbar" aria-label="地图工具">
      {tools.map((tool) => {
        const isPlayback = tool.label === "播放";
        const Icon = isPlayback && isPlaying ? Pause : tool.icon;

        return (
          <button
            key={tool.label}
            type="button"
            title={isPlayback ? (isPlaying ? "暂停" : "播放") : tool.label}
            onClick={isPlayback ? togglePlaying : undefined}
          >
            <Icon size={20} />
          </button>
        );
      })}
    </aside>
  );
}

