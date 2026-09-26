import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { Laptop, Copy, Check, QrCode, X, Download } from 'lucide-react';

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
          <div className="space-y-5">
            {/* Step 1: Download App */}
            <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800">
              <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5 mb-2">
                <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center text-[11px] font-black">
                  1
                </span>
                <span>Download & Install SafeBrowse on Child's Device</span>
              </div>
              <p className="text-[11px] text-slate-400 mb-3">
                Download and install SafeBrowse Child Protection on the child's Windows device:
              </p>
              <div className="flex">
                <a
                  href="/api/downloads/windows"
                  download="SafeBrowseChild-Pilot.msi"
                  className="w-full flex items-center justify-between py-2.5 px-4 rounded-xl bg-indigo-950/40 hover:bg-indigo-900/40 border border-indigo-500/30 text-indigo-300 text-xs font-bold transition group cursor-pointer"
                  title="Download Windows Installer (MSI)"
                >
                  <div className="flex items-center gap-2">
                    <Laptop className="w-4 h-4 text-indigo-400 group-hover:scale-110 transition-transform" />
                    <span>Download Windows Installer (.msi)</span>
                  </div>
                  <Download className="w-3.5 h-3.5 text-indigo-400 opacity-70 group-hover:opacity-100" />
                </a>
              </div>
            </div>

            {/* Step 2: QR Code & PIN Code Display */}
            <div>
              <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5 mb-2">
                <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center text-[11px] font-black">
                  2
                </span>
                <span>Enter Pairing Code on Child Device</span>
              </div>
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
            </div>

            {/* Quick Testing Actions */}
            <div className="border-t border-slate-800 pt-4 space-y-3">
              <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <QrCode className="w-3.5 h-3.5 text-emerald-400" />
                <span>Instant Test Pair (Simulate Device)</span>
              </div>
              <p className="text-xs text-slate-400">
                Simulate instant Windows laptop pairing for this session:
              </p>

              <div>
                <button
                  disabled={quickPairing}
                  onClick={() => handleSimulateQuickPair('windows')}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-bold text-xs bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 transition-all cursor-pointer"
                >
                  <Laptop className="w-4 h-4 text-indigo-400" />
                  <span>Simulate Windows Laptop Pair</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
