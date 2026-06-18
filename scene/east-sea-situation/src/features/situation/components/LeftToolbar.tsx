import {
  CircleDotDashed,
  Globe2,
  Layers3,
  ListFilter,
  Play,
  Radar,
  Route,
  Share2,
  Table2,
} from "lucide-react";
import { useSituationStore } from "../useSituationStore";

const tools = [
  { label: "地图", icon: Globe2 },
  { label: "播放", icon: Play },
  { label: "航迹", icon: Route },
  { label: "图层", icon: Layers3 },
  { label: "表格", icon: Table2 },
  { label: "筛选", icon: ListFilter },
  { label: "关联", icon: Share2 },
  { label: "雷达", icon: Radar },
  { label: "融合", icon: CircleDotDashed },
];

export function LeftToolbar() {
  const advancePlayback = useSituationStore((state) => state.advancePlayback);

  return (
    <aside className="left-toolbar" aria-label="地图工具">
      {tools.map((tool) => {
        const Icon = tool.icon;
        const isPlayback = tool.label === "播放";

        return (
          <button
            key={tool.label}
            type="button"
            title={tool.label}
            onClick={isPlayback ? advancePlayback : undefined}
          >
            <Icon size={20} />
          </button>
        );
      })}
    </aside>
  );
}

