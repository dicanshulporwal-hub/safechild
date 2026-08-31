import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { Smartphone, Laptop, Copy, Check, QrCode } from 'lucide-react';

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
            width: 180,
            margin: 1,
            color: {
              dark: '#0f172a',
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
      const name = `${childName}'s ${platform === 'android' ? 'Samsung Phone' : 'Windows Laptop'}`;
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
    <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
      <div className="bg-white rounded-3xl max-w-lg w-full p-6 sm:p-8 shadow-2xl border border-slate-100">
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div>
            <h3 className="text-xl font-extrabold text-slate-900 tracking-tight">Connect a Device</h3>
            <p className="text-xs text-slate-500 mt-0.5">Link a phone or laptop to {childName}'s profile</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-xl hover:bg-slate-100"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="py-16 text-center text-slate-400 text-sm">
            Generating secure pairing token...
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            {/* QR Code & PIN Code Display */}
            <div className="flex flex-col sm:flex-row items-center gap-6 bg-slate-50 p-5 rounded-2xl border border-slate-200/80">
              <div className="bg-white p-2 rounded-xl border border-slate-200 shadow-sm flex items-center justify-center">
                <canvas ref={canvasRef} className="w-36 h-36 rounded-lg" />
              </div>

              <div className="flex-1 text-center sm:text-left">
                <div className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                  Or enter 6-digit code
                </div>
                <div className="text-3xl font-black text-slate-900 tracking-wider my-1 font-mono">
                  {pairingCode}
                </div>
                <p className="text-[11px] text-slate-500 mb-3">Code expires in 10 minutes</p>

                <button
                  onClick={copyToClipboard}
                  className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 shadow-sm transition-all"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="text-emerald-700">Copied!</span>
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
            <div className="border-t border-slate-100 pt-5">
              <div className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <QrCode className="w-3.5 h-3.5 text-emerald-600" />
                <span>Instant Test Pair (Connect Device Now)</span>
              </div>
              <p className="text-xs text-slate-500 mb-3">
                Select a device type below to simulate instant pairing for this session:
              </p>

              <div className="grid grid-cols-2 gap-3">
                <button
                  disabled={quickPairing}
                  onClick={() => handleSimulateQuickPair('android')}
                  className="flex items-center justify-center space-x-2 py-3 px-4 rounded-xl font-bold text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-200 transition-all"
                >
                  <Smartphone className="w-4 h-4 text-emerald-600" />
                  <span>Pair Android Phone</span>
                </button>

                <button
                  disabled={quickPairing}
                  onClick={() => handleSimulateQuickPair('windows')}
                  className="flex items-center justify-center space-x-2 py-3 px-4 rounded-xl font-bold text-xs bg-blue-50 hover:bg-blue-100 text-blue-900 border border-blue-200 transition-all"
                >
                  <Laptop className="w-4 h-4 text-blue-600" />
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
