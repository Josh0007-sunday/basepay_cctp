
export function TransferTypeSelector({
  value,
  onChange,
}: {
  value: "fast" | "standard";
  onChange: (value: "fast" | "standard") => void;
}) {
  return (
    <div className="flex w-full">
      <button
        type="button"
        className={`flex-1 px-4 py-2 rounded-l-md border border-gray-300 ${
          value === "fast"
            ? "bg-primary text-white"
            : "bg-white text-gray-700 hover:bg-gray-100"
        }`}
        onClick={() => onChange("fast")}
      >
        🚀 V2 Fast
      </button>
      <button
        type="button"
        className={`flex-1 px-4 py-2 rounded-r-md border border-gray-300 border-l-0 ${
          value === "standard"
            ? "bg-primary text-white"
            : "bg-white text-gray-700 hover:bg-gray-100"
        }`}
        onClick={() => onChange("standard")}
      >
        🛡️ V1 Standard
      </button>
    </div>
  );
}