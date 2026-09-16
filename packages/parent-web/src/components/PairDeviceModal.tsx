import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { Smartphone, Laptop, Copy, Check, QrCode, X } from 'lucide-react';

interface PairDeviceModalProps {
  childId: string;
  childName: string;
  onClose: () => void;
  onDevicePaired: () => void;
}

export const PairDeviceModal: React.FC<PairDeviceModalProps> = ({
  childId,
  childName,
  onClose,
  onDevicePaired,
}) => {
  const [pairingCode, setPairingCode] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [quickPairing, setQuickPairing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    async function fetchCode() {
      try {
        setLoading(true);
        const data = await api.createPairingCode(childId);
        setPairingCode(data.code);

        if (canvasRef.current) {
          await QRCode.toCanvas(canvasRef.current, JSON.stringify({
            app: 'safebrowse',
            code: data.code,
            childId,
          }), {
            width: 160,
            margin: 1,
            color: {
              dark: '#020617',
              light: '#ffffff',
            },
          });
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }

    fetchCode();
  }, [childId]);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(pairingCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSimulateQuickPair = async (platform: 'android' | 'windows') => {
    try {
      setQuickPairing(true);
      const name = `${childName}'s ${platform === 'android' ? 'Samsung Galaxy' : 'Dell XPS Laptop'}`;
      await api.claimPairingCode(pairingCode, name, platform);
      onDevicePaired();
      onClose();
    } catch (e: any) {
      alert(e.message || 'Pairing error');
    } finally {
      setQuickPairing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h3 className="text-xl font-extrabold text-white tracking-tight">Connect a Device</h3>
            <p className="text-xs text-slate-400 mt-0.5">Link a phone or laptop to {childName}'s profile</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="py-16 text-center text-slate-400 text-xs font-semibold">
            Generating secure pairing token...
          </div>
        ) : (
          <div className="space-y-6">
            {/* QR Code & PIN Code Display */}
            <div className="flex flex-col sm:flex-row items-center gap-6 bg-slate-950/80 p-5 rounded-2xl border border-slate-800/80">
              <div className="bg-white p-2 rounded-2xl shadow-inner flex items-center justify-center shrink-0">
                <canvas ref={canvasRef} className="w-36 h-36 rounded-lg" />
              </div>

              <div className="flex-1 text-center sm:text-left">
                <div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400">
                  Or enter 6-digit code
                </div>
                <div className="text-3xl font-black text-white tracking-wider my-1 font-mono text-emerald-400">
                  {pairingCode}
                </div>
                <p className="text-[11px] text-slate-400 mb-3">Code expires in 10 minutes</p>

                <button
                  onClick={copyToClipboard}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-xs font-bold text-slate-200 shadow-sm transition-all cursor-pointer"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-300">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Code</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Quick Testing Actions */}
            <div className="border-t border-slate-800 pt-4 space-y-3">
              <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <QrCode className="w-3.5 h-3.5 text-emerald-400" />
                <span>Instant Test Pair (Simulate Device)</span>
              </div>
              <p className="text-xs text-slate-400">
                Select a device type below to simulate instant pairing for this session:
              </p>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  disabled={quickPairing}
                  onClick={() => handleSimulateQuickPair('android')}
                  className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-bold text-xs bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 transition-all cursor-pointer"
                >
                  <Smartphone className="w-4 h-4 text-emerald-400" />
                  <span>Pair Android Phone</span>
                </button>

                <button
                  disabled={quickPairing}
                  onClick={() => handleSimulateQuickPair('windows')}
                  className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-bold text-xs bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 transition-all cursor-pointer"
                >
                  <Laptop className="w-4 h-4 text-indigo-400" />
                  <span>Pair Windows Laptop</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
