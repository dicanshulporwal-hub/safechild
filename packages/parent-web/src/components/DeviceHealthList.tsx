import React from 'react';
import { Device } from '../api/client';
import { Smartphone, Laptop, Plus, Trash2, CheckCircle2, AlertCircle, RefreshCw, Stethoscope } from 'lucide-react';

interface DeviceHealthListProps {
  childName: string;
  devices: Device[];
  onOpenPairModal: () => void;
  onRemoveDevice: (deviceId: string) => void;
  onRunDiagnostics?: (device: Device) => void;
}

export const DeviceHealthList: React.FC<DeviceHealthListProps> = ({
  childName,
  devices,
  onOpenPairModal,
  onRemoveDevice,
  onRunDiagnostics,
}) => {
  const formatTimeAgo = (dateStr: string) => {
    const elapsedSec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (elapsedSec < 10) return 'Just now';
    if (elapsedSec < 60) return `${elapsedSec}s ago`;
    const elapsedMin = Math.floor(elapsedSec / 60);
    if (elapsedMin < 60) return `${elapsedMin}m ago`;
    const elapsedHrs = Math.floor(elapsedMin / 60);
    return `${elapsedHrs}h ago`;
  };

  return (
    <div className="bg-white rounded-3xl p-6 sm:p-7 shadow-sm border border-slate-200/80">
      <div className="flex items-center justify-between pb-6 border-b border-slate-100">
        <div>
          <h3 className="text-xl font-black text-slate-900 tracking-tight">Connected Devices</h3>
          <p className="text-xs text-slate-500 font-medium mt-0.5">
            Real-time protection health for {childName}'s devices.
          </p>
        </div>

        <button
          onClick={onOpenPairModal}
          className="flex items-center space-x-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-md shadow-emerald-600/20 transition-all"
        >
          <Plus className="w-4 h-4" />
          <span>+ Add Device</span>
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {devices.length === 0 ? (
          <div className="text-center py-10 bg-slate-50 rounded-2xl border border-dashed border-slate-200 p-6">
            <Smartphone className="w-8 h-8 text-slate-400 mx-auto mb-2" />
            <h4 className="text-sm font-bold text-slate-700">No Devices Connected</h4>
            <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1 mb-4">
              Connect {childName}'s phone or laptop using a pairing code or QR to start enforcing website rules.
            </p>
            <button
              onClick={onOpenPairModal}
              className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold"
            >
              Pair First Device
            </button>
          </div>
        ) : (
          devices.map((device) => {
            const isProtected = device.healthStatus === 'protected';
            const isSyncing = device.healthStatus === 'syncing';

            return (
              <div
                key={device.id}
                className="flex items-center justify-between p-4 rounded-2xl bg-slate-50 hover:bg-slate-100/70 border border-slate-100 transition-all group"
              >
                <div className="flex items-center space-x-4">
                  {/* Device Icon */}
                  <div className="w-11 h-11 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-700 shadow-sm">
                    {device.platform === 'android' ? (
                      <Smartphone className="w-5 h-5 text-emerald-600" />
                    ) : (
                      <Laptop className="w-5 h-5 text-blue-600" />
                    )}
                  </div>

                  <div>
                    <div className="flex items-center space-x-2.5">
                      <span className="font-extrabold text-sm text-slate-900">{device.name}</span>
                      
                      {/* Health Status Badge */}
                      {isProtected ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          Protected
                        </span>
                      ) : isSyncing ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800">
                          <RefreshCw className="w-3 h-3 text-amber-600 animate-spin" />
                          Syncing
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800">
                          <AlertCircle className="w-3 h-3 text-red-600" />
                          Protection Inactive
                        </span>
                      )}
                    </div>

                    <div className="flex items-center space-x-3 text-xs text-slate-500 mt-1">
                      <span>Policy v{device.activePolicyVersion}</span>
                      <span>•</span>
                      <span>Last sync: {formatTimeAgo(device.lastHeartbeatAt)}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center space-x-1">
                  {onRunDiagnostics && (
                    <button
                      onClick={() => onRunDiagnostics(device)}
                      className="px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:text-emerald-700 bg-white hover:bg-emerald-50 rounded-xl border border-slate-200 transition-all flex items-center space-x-1 shadow-xs"
                      title="Run Protection Check diagnostic"
                    >
                      <Stethoscope className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="hidden sm:inline">Check</span>
                    </button>
                  )}

                  <button
                    onClick={() => onRemoveDevice(device.id)}
                    className="opacity-0 group-hover:opacity-100 p-2 text-slate-400 hover:text-red-600 rounded-xl hover:bg-red-50 transition-all"
                    title="Unpair device"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
