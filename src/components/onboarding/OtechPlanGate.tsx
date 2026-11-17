import { useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Globe,
  Key,
  Laptop,
  Loader2,
  MessageCircle,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { setLanguageChoice, useLanguageChoice } from "@/lib/language-preference";
import { useOtechLicense } from "@/lib/otech-license";

const WHATSAPP_PHONE = "962791234567";

export function OtechPlanGate() {
  const { license, isLocked, activateKey, startTrial } = useOtechLicense();
  const rawLang = useLanguageChoice();
  const isArabic = rawLang === "ar" || (!rawLang && typeof navigator !== "undefined" && navigator.language?.startsWith("ar"));

  const [inputKey, setInputKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // If not locked and has a plan, do not show gate
  if (!isLocked && license.plan) {
    return null;
  }

  const handleActivate = async (keyToUse?: string) => {
    const k = (keyToUse || inputKey).trim().toUpperCase();
    if (!k) {
      setErrorMsg(isArabic ? "يرجى إدخال مفتاح الترخيص" : "Please enter a license key");
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await activateKey(k);
      if (res.success) {
        setSuccessMsg(
          isArabic
            ? `تم تفعيل الباقة بنجاح (${res.state.customer || "عميل OTECH"})`
            : `Plan activated successfully (${res.state.customer || "OTECH Customer"})`
        );
      } else {
        if (res.state.status === "expired") {
          setErrorMsg(
            isArabic
              ? "مفتاح الترخيص منتهي الصلاحية! يرجى التواصل معنا للتجديد."
              : "This license key has expired! Please contact support to renew."
          );
        } else if (res.state.status === "revoked") {
          setErrorMsg(
            isArabic
              ? "تم إيقاف مفتاح الترخيص هذا. يرجى التواصل مع الدعم الفني."
              : "This license key has been revoked. Please contact support."
          );
        } else {
          setErrorMsg(
            isArabic
              ? (res.message || "مفتاح الترخيص غير صالح، تأكد من الصيغة OTECH-JO-XXXX-XXXX")
              : (res.message || "Invalid license key format (OTECH-JO-XXXX-XXXX)")
          );
        }
      }
    } catch (err: any) {
      setErrorMsg(isArabic ? "حدث خطأ أثناء التحقق من الترخيص" : "Error verifying license key");
    } finally {
      setLoading(false);
    }
  };

  const handleStartTrial = () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = startTrial();
      if (!res.success) {
        setErrorMsg(isArabic ? (res.message || "انتهت فترة التجربة المجانية سابقاً") : (res.message || "Trial period has ended"));
      } else {
        setSuccessMsg(isArabic ? "تم تفعيل التجربة المجانية لمدة 7 أيام بنجاح!" : "7-Day Free Trial activated successfully!");
      }
    } finally {
      setLoading(false);
    }
  };

  const openWhatsApp = () => {
    const msg = isArabic
      ? "مرحباً، أود الاستفسار عن تجديد أو تفعيل ترخيص تطبيق OTECH."
      : "Hello, I would like to inquire about renewing or activating my OTECH application license.";
    const url = `https://wa.me/${WHATSAPP_PHONE}?text=${encodeURIComponent(msg)}`;
    if (typeof window !== "undefined") {
      window.open(url, "_blank");
    }
  };

  return (
    <div
      dir={isArabic ? "rtl" : "ltr"}
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-950 text-slate-100 flex flex-col justify-between p-4 sm:p-6 md:p-8 font-sans select-none"
    >
      {/* Top Navigation: Brand + Language Selector */}
      <div className="w-full max-w-6xl mx-auto flex items-center justify-between pb-6 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-sky-500/20 text-lg">
            O
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              OTECH <span className="text-xs px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-400 font-medium">v0.1.161</span>
            </h1>
            <p className="text-xs text-slate-400">
              {isArabic ? "حلول الذكاء الاصطناعي وإدارة الأعمال — الأردن" : "Enterprise AI Solutions — Jordan"}
            </p>
          </div>
        </div>

        {/* Language Picker */}
        <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-full p-1 shadow-inner">
          <Globe className="w-4 h-4 text-slate-400 ms-2" />
          <button
            type="button"
            onClick={() => setLanguageChoice("ar")}
            className={`px-3 py-1 text-xs font-semibold rounded-full transition-all ${
              isArabic
                ? "bg-sky-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            العربية
          </button>
          <button
            type="button"
            onClick={() => setLanguageChoice("en")}
            className={`px-3 py-1 text-xs font-semibold rounded-full transition-all ${
              !isArabic
                ? "bg-sky-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            English
          </button>
        </div>
      </div>

      {/* Hero Header */}
      <div className="w-full max-w-4xl mx-auto text-center my-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-400 text-xs font-medium mb-3">
          <ShieldCheck className="w-4 h-4" />
          {isArabic ? "بوابات الاشتراك والترخيص الرسمي" : "Official Licensing & Plan Gate"}
        </div>
        <h2 className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-white mb-2">
          {isArabic ? "OTECH — اختر باقتك المفضلة" : "OTECH — Choose Your Plan"}
        </h2>
        <p className="text-sm sm:text-base text-slate-400 max-w-2xl mx-auto">
          {isArabic
            ? "قم بتفعيل باقتك للبدء في استخدام بوتات OTECH وإدارة مهام أعمالك بكفاءة عالية."
            : "Activate your plan to start utilizing OTECH bots and supercharge your business productivity."}
        </p>

        {/* Expired State Warning */}
        {license.status === "expired" && (
          <div className="mt-4 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 max-w-xl mx-auto flex items-center justify-between gap-4 text-start">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-6 h-6 text-amber-400 shrink-0" />
              <div>
                <p className="text-sm font-bold">
                  {isArabic ? "انتهت صلاحية باقتك الحالية!" : "Your current plan has expired!"}
                </p>
                <p className="text-xs text-amber-300/80">
                  {isArabic ? "لتجديد الترخيص ومواصلة العمل، تواصل معنا مباشرة." : "To renew your license and resume work, contact us."}
                </p>
              </div>
            </div>
            <button
              onClick={openWhatsApp}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 transition"
            >
              <MessageCircle className="w-4 h-4" />
              {isArabic ? "تجديد عبر واتساب" : "Renew WhatsApp"}
            </button>
          </div>
        )}
      </div>

      {/* Plan Cards Grid */}
      <div className="w-full max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6 my-4">
        {/* 1. Trial Plan */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between hover:border-slate-700 transition relative group">
          <div>
            <div className="flex items-center justify-between mb-4">
              <span className="p-2.5 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20">
                <Sparkles className="w-6 h-6" />
              </span>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300">
                {isArabic ? "بدون بطاقة ائتمان" : "No Card Required"}
              </span>
            </div>

            <h3 className="text-lg font-bold text-white mb-1">
              {isArabic ? "تجربة مجانية (7 أيام)" : "Free Trial (7 Days)"}
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              {isArabic ? "استكشف كافة الإمكانيات مجاناً لمدة أسبوع كامل" : "Explore full capabilities for a week"}
            </p>

            <div className="flex items-baseline gap-1 mb-6">
              <span className="text-3xl font-extrabold text-white">{isArabic ? "مجاناً" : "Free"}</span>
              <span className="text-xs text-slate-400">/ 7 {isArabic ? "أيام" : "days"}</span>
            </div>

            <ul className="space-y-2.5 text-xs text-slate-300 border-t border-slate-800/80 pt-4 mb-6">
              <li className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{isArabic ? "فتح كافة البوتات والميزات فوراً" : "Instant access to all bots"}</span>
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{isArabic ? "دعم كامل للغة العربية والإنجليزية" : "Full Arabic & English support"}</span>
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{isArabic ? "ينتهي تلقائياً بعد 7 أيام بدون رسوم" : "Auto-locks after 7 days without charges"}</span>
              </li>
            </ul>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={handleStartTrial}
            className="w-full py-2.5 px-4 rounded-xl font-semibold text-xs transition bg-slate-800 hover:bg-slate-700 text-white flex items-center justify-center gap-2 border border-slate-700"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-purple-400" />}
            {isArabic ? "بدء التجربة المجانية (7 أيام)" : "Start 7-Day Free Trial"}
          </button>
        </div>

        {/* 2. OTECH Local Managed */}
        <div className="bg-slate-900 border-2 border-sky-500 rounded-2xl p-6 flex flex-col justify-between relative shadow-xl shadow-sky-950/40">
          <div className="absolute -top-3 start-6 px-3 py-0.5 rounded-full bg-sky-500 text-white text-[11px] font-bold tracking-wide shadow-md">
            {isArabic ? "الأكثر طلباً" : "Most Popular"}
          </div>

          <div>
            <div className="flex items-center justify-between mb-4">
              <span className="p-2.5 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20">
                <Laptop className="w-6 h-6" />
              </span>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-sky-950/80 text-sky-300 border border-sky-800/60">
                {isArabic ? "ترخيص محلي" : "Local License"}
              </span>
            </div>

            <h3 className="text-lg font-bold text-white mb-1">
              OTECH Local Managed
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              {isArabic ? "تشغيل محلي على هذا الجهاز بدون سحابة" : "Runs locally on this PC without cloud dependencies"}
            </p>

            <div className="flex items-baseline gap-1 mb-6">
              <span className="text-3xl font-extrabold text-white">20</span>
              <span className="text-sm font-semibold text-sky-400">{isArabic ? "د.أ" : "JOD"}</span>
              <span className="text-xs text-slate-400">/ {isArabic ? "شهرياً" : "month"}</span>
            </div>

            <ul className="space-y-2.5 text-xs text-slate-300 border-t border-slate-800/80 pt-4 mb-6">
              <li className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{isArabic ? "جميع البوتات تعمل محلياً على جهازك" : "All bots run locally on your machine"}</span>
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{isArabic ? "أمان تام وخصوصية مطلقة لبياناتك" : "100% privacy and local data security"}</span>
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{isArabic ? "مهلة 3 أيام في حال انقطاع الإنترنت" : "3-day offline grace period"}</span>
              </li>
              <li className="flex items-center gap-2 text-slate-400">
                <span className="w-4 h-4 text-slate-500 text-center font-bold">✕</span>
                <span>{isArabic ? "السحابة معطلة (ترقية للسحابي متاحة)" : "Cloud disabled (upgrade available)"}</span>
              </li>
            </ul>
          </div>

          <div className="pt-2">
            <span className="block text-center text-[11px] text-sky-400/80 mb-2 font-medium">
              {isArabic ? "يتطلب مفتاح ترخيص OTECH-JO" : "Requires OTECH-JO license key"}
            </span>
          </div>
        </div>

        {/* 3. OTECH Cloud Always On */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between hover:border-slate-700 transition relative">
          <div>
            <div className="flex items-center justify-between mb-4">
              <span className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <Cloud className="w-6 h-6" />
              </span>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-indigo-950/80 text-indigo-300 border border-indigo-800/60">
                {isArabic ? "سحابي كامل 24/7" : "Cloud 24/7"}
              </span>
            </div>

            <h3 className="text-lg font-bold text-white mb-1">
              OTECH Cloud Always On
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              {isArabic ? "سيرفر سحابي يعمل على مدار الساعة + أجهزة Boat" : "24/7 Always On cloud machine + Boat desktops"}
            </p>

            <div className="flex items-baseline gap-1 mb-6">
              <span className="text-3xl font-extrabold text-white">35</span>
              <span className="text-sm font-semibold text-indigo-400">{isArabic ? "د.أ" : "JOD"}</span>
              <span className="text-xs text-slate-400">/ {isArabic ? "شهرياً" : "month"}</span>
            </div>

            <ul className="space-y-2.5 text-xs text-slate-300 border-t border-slate-800/80 pt-4 mb-6">
              <li className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{isArabic ? "سيرفر سحابي مستقل يعمل 24/7" : "24/7 Standalone Cloud server"}</span>
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{isArabic ? "تكامل أجهزة وسطح مكتب Boat Desktops" : "Boat Desktops integration"}</span>
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{isArabic ? "الوصول من أي مكان وفي أي وقت" : "Access from any device anywhere"}</span>
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{isArabic ? "أولوية دعم فني مباشر" : "Priority direct technical support"}</span>
              </li>
            </ul>
          </div>

          <div className="pt-2">
            <span className="block text-center text-[11px] text-indigo-400/80 mb-2 font-medium">
              {isArabic ? "يتطلب مفتاح ترخيص OTECH-JO" : "Requires OTECH-JO license key"}
            </span>
          </div>
        </div>
      </div>

      {/* Activation Form Box */}
      <div className="w-full max-w-2xl mx-auto bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl my-4">
        <div className="flex items-center gap-2.5 mb-3 text-white font-semibold text-sm">
          <Key className="w-4 h-4 text-sky-400" />
          <span>{isArabic ? "تفعيل باقة باستخدام مفتاح الترخيص:" : "Activate plan using License Key:"}</span>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            dir="ltr"
            placeholder="OTECH-JO-XXXX-XXXX"
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleActivate();
            }}
            className="flex-1 bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-xl px-4 py-2.5 text-sm font-mono tracking-widest text-white placeholder-slate-500 outline-none transition"
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => void handleActivate()}
            className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs flex items-center justify-center gap-2 transition shrink-0 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : isArabic ? <ArrowLeft className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
            <span>{isArabic ? "تفعيل الترخيص" : "Activate License"}</span>
          </button>
        </div>

        {/* Feedback Messages */}
        {errorMsg && (
          <div className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
        {successMsg && (
          <div className="mt-3 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center gap-2">
            <Check className="w-4 h-4 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Quick Demo Test Keys Helpers */}
        <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between text-[11px] text-slate-400 gap-2">
          <span>{isArabic ? "مفاتيح الفحص السريع:" : "Quick test keys:"}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setInputKey("OTECH-JO-A7K9-2M4P");
                void handleActivate("OTECH-JO-A7K9-2M4P");
              }}
              className="text-sky-400 hover:underline font-mono bg-slate-800 px-2 py-0.5 rounded"
            >
              OTECH-JO-A7K9-2M4P ({isArabic ? "صالح" : "Valid"})
            </button>
            <button
              type="button"
              onClick={() => {
                setInputKey("OTECH-JO-EXPD-9941");
                void handleActivate("OTECH-JO-EXPD-9941");
              }}
              className="text-amber-400 hover:underline font-mono bg-slate-800 px-2 py-0.5 rounded"
            >
              OTECH-JO-EXPD-9941 ({isArabic ? "منتهي" : "Expired"})
            </button>
          </div>
        </div>
      </div>

      {/* Footer Support */}
      <div className="w-full max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 pt-6 border-t border-slate-800 text-xs text-slate-400 text-center sm:text-start">
        <div className="flex items-center gap-2">
          <span>{isArabic ? "مكتب عمان، الأردن • خدمة العملاء:" : "Amman Office, Jordan • Customer Service:"}</span>
          <span dir="ltr" className="font-mono text-slate-300">+962 7 9123 4567</span>
        </div>
        <button
          type="button"
          onClick={openWhatsApp}
          className="inline-flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 transition font-medium"
        >
          <MessageCircle className="w-4 h-4" />
          <span>{isArabic ? "تواصل معنا مباشرة عبر واتساب" : "Contact us on WhatsApp"}</span>
        </button>
      </div>
    </div>
  );
}
