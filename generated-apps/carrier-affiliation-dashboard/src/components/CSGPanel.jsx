import CarrierCard from './CarrierCard';
import PlatformTable from './PlatformTable';

export default function CSGPanel({ sg }) {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-header">
        <span>{sg.name} ({sg.id})</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
          平台 {sg.platformCount} | 舰载机 {sg.aircraft.length} | 舰船 {sg.ships.length}
        </span>
      </div>
      <div className="card-body">
        {sg.carrier ? (
          <CarrierCard carrier={sg.carrier} />
        ) : (
          <div className="empty-state">
            <div className="empty-icon">-</div>
            未关联航母
          </div>
        )}
        <PlatformTable
          platforms={sg.aircraft}
          title={`舰载机（隶属 ${sg.id}）`}
          emptyMessage="暂无舰载机数据"
        />
        <PlatformTable
          platforms={sg.ships}
          title={`护航舰船（隶属 ${sg.id}）`}
          emptyMessage="暂无护航舰船数据"
        />
      </div>
    </div>
  );
}
