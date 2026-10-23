import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { Laptop, Smartphone, Copy, Check, X, Download, ShieldCheck } from 'lucide-react';

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
  const [platform, setPlatform] = useState<'windows' | 'android'>('windows');
  const [pairingCode, setPairingCode] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    async function fetchCode() {
      try {
        setLoading(true);
        const data = await api.createPairingCode(childId);
        setPairingCode(data.code);

        if (canvasRef.current) {
          await QRCode.toCanvas(
            canvasRef.current,
            JSON.stringify({
              app: 'safebrowse',
              code: data.code,
              childId,
            }),
            {
              width: 140,
              margin: 1,
              color: {
                dark: '#020617',
                light: '#ffffff',
              },
            }
          );
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

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h3 className="text-xl font-extrabold text-white tracking-tight">Add a Device</h3>
            <p className="text-xs text-slate-400 mt-0.5">Protect your family on {childName}'s computer or phone</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step 1: Device Type Selector */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setPlatform('windows')}
            className={`p-3.5 rounded-2xl border text-left transition flex items-center gap-3 ${
              platform === 'windows'
                ? 'bg-indigo-600/15 border-indigo-500/40 text-white shadow-sm'
                : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700'
            }`}
          >
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${
              platform === 'windows' ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-400'
            }`}>
              <Laptop className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs font-bold text-white">Windows PC</div>
              <div className="text-[11px] text-slate-400">Laptop or Desktop</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setPlatform('android')}
            className={`p-3.5 rounded-2xl border text-left transition flex items-center gap-3 ${
              platform === 'android'
                ? 'bg-indigo-600/15 border-indigo-500/40 text-white shadow-sm'
                : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700'
            }`}
          >
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${
              platform === 'android' ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-400'
            }`}>
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs font-bold text-white">Android</div>
              <div className="text-[11px] text-slate-400">Phone or Tablet</div>
            </div>
          </button>
        </div>

        {loading ? (
          <div className="py-16 text-center text-slate-400 text-xs font-semibold">
            Generating secure pairing token...
          </div>
        ) : (
          <div className="space-y-4">
            {/* Step 2: Download & Install Instructions */}
            <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-3">
              <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center text-[11px] font-black">
                  1
                </span>
                <span>Install SafeBrowse</span>
              </div>

              {platform === 'windows' ? (
                <>
                  <a
                    href="/api/downloads/windows"
                    download="SafeBrowseChild-Pilot.msi"
                    className="w-full flex items-center justify-between py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/20 cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <Download className="w-4 h-4" />
                      <span>Download Windows Installer (.msi)</span>
                    </div>
                    <span className="text-[11px] opacity-80">v1.0.4</span>
                  </a>

                  <ol className="text-[12px] text-slate-300 space-y-1.5 pl-4 list-decimal leading-relaxed">
                    <li>Download and run the installer on the computer</li>
                    <li>Click <strong>Yes</strong> when Windows asks for permission (UAC)</li>
                    <li>Enter the 6-digit code below when prompted</li>
                  </ol>
                </>
              ) : (
                <>
                  <a
                    href="/api/downloads/android"
                    download="safebrowse-agent.apk"
                    className="w-full flex items-center justify-between py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-lg shadow-emerald-600/20 cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <Download className="w-4 h-4" />
                      <span>Download Android App (.apk)</span>
                    </div>
                    <span className="text-[11px] opacity-80">v1.0.4</span>
                  </a>

                  <ol className="text-[12px] text-slate-300 space-y-1.5 pl-4 list-decimal leading-relaxed">
                    <li>Install and open SafeBrowse on the Android device</li>
                    <li>Scan the QR code or enter the 6-digit code below</li>
                    <li>Follow the on-screen steps to enable VPN protection</li>
                  </ol>
                </>
              )}
            </div>

            {/* Step 3: Pairing Code */}
            <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
              <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center text-[11px] font-black">
                  2
                </span>
                <span>Enter This 6-Digit Code</span>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-4">
                {platform === 'android' && (
                  <div className="bg-white p-2 rounded-2xl shadow-inner flex items-center justify-center shrink-0">
                    <canvas ref={canvasRef} className="w-28 h-28 rounded-lg" />
                  </div>
                )}

                <div className="flex-1 text-center sm:text-left">
                  <div className="text-3xl font-black text-emerald-400 tracking-wider font-mono my-0.5">
                    {pairingCode}
                  </div>
                  <p className="text-[11px] text-slate-400 mb-2">Code expires in 10 minutes</p>

                  <button
                    onClick={copyToClipboard}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-xs font-bold text-slate-200 shadow-sm transition cursor-pointer"
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

              {platform === 'windows' && (
                <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-[11px] text-slate-400 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                  <span>
                    Enter this code when SafeBrowse asks for it on the computer. SafeBrowse will ask who uses each Windows account. That's all!
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

