import SwiftUI

public struct SQLResultTableView: View {
    public let title: String
    public let columns: [String]
    public let rows: [[String]]
    public let rawQuery: String?
    
    @Environment(\.colorScheme) private var colorScheme
    
    public init(
        title: String = "DATA TABLE",
        columns: [String],
        rows: [[String]],
        rawQuery: String? = nil
    ) {
        self.title = title
        self.columns = columns
        self.rows = rows
        self.rawQuery = rawQuery
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        
        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack {
                HStack(spacing: 5) {
                    Image(systemName: "tablecells.fill")
                        .font(.system(size: 11))
                        .foregroundColor(Color(hex: "#3ECF8E"))
                    Text(title.uppercased())
                        .font(.system(size: 9.5, weight: .heavy))
                        .foregroundColor(Color(hex: "#3ECF8E"))
                }
                
                Spacer()
                
                Text("\(rows.count) rows")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2.5)
                    .background(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
                    .clipShape(Capsule())
            }
            
            // Raw Query if present
            if let query = rawQuery, !query.isEmpty {
                Text(query)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(isDark ? Color(hex: "#F8FAFC") : Color(hex: "#0F172A"))
                    .lineLimit(2)
                    .padding(6)
                    .background(isDark ? Color.black.opacity(0.4) : Color.black.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            
            // Scrollable Grid
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 4) {
                    // Column Headers
                    HStack(spacing: 12) {
                        ForEach(Array(columns.enumerated()), id: \.offset) { _, col in
                            Text(col.uppercased())
                                .font(.system(size: 9.5, weight: .heavy, design: .monospaced))
                                .foregroundColor(Color(hex: "#3ECF8E"))
                                .frame(minWidth: 65, alignment: .leading)
                        }
                    }
                    .padding(.bottom, 2)
                    
                    Divider().background(isDark ? Color.white.opacity(0.12) : Color.black.opacity(0.08))
                    
                    // Rows
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        HStack(spacing: 12) {
                            ForEach(Array(columns.indices), id: \.self) { colIdx in
                                let val = colIdx < row.count ? row[colIdx] : ""
                                Text(val)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                                    .frame(minWidth: 65, alignment: .leading)
                            }
                        }
                        .padding(.vertical, 1.5)
                    }
                }
            }
            
            Divider().background(isDark ? Color.white.opacity(0.12) : Color.black.opacity(0.08))
            
            // Footer
            HStack {
                Button {
                    let csv = ([columns] + rows)
                        .map { $0.map(Self.csvField).joined(separator: ",") }
                        .joined(separator: "\n")
                    PlatformBridge.copyToPasteboard(csv)
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "doc.on.doc")
                        Text("Copy CSV")
                    }
                    .font(.caption2.weight(.medium))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                }
                .buttonStyle(.plain)
                
                Spacer()
            }
        }
        .padding(10)
        .background(
            LinearGradient(
                colors: isDark ? [
                    Color(hex: "#171717").opacity(0.96),
                    Color(hex: "#1C1C1C").opacity(0.92)
                ] : [
                    Color.white.opacity(0.96),
                    Color(hex: "#F8FAFC").opacity(0.92)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(hex: "#3ECF8E").opacity(0.35), lineWidth: 0.8)
        )
        .shadow(color: Color.black.opacity(isDark ? 0.20 : 0.04), radius: 4, y: 1.5)
    }

    private static func csvField(_ value: String) -> String {
        guard value.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" || $0 == "\r" }) else {
            return value
        }
        return "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}
