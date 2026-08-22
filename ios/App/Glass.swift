// The one material the chrome is made of.
//
// Every floating control — the header tiles, the Updates pill, the round
// buttons, the sheets, the chat's back pill and composer — is the same glass,
// so the app reads as one object rather than a collection of buttons. On
// iOS 26 it is the system's Liquid Glass, which refracts what scrolls
// beneath it; before that, a thin material with a hairline does the same
// job in the same shape, just without the light.
import SwiftUI

/// Something floating over content: a tile, a pill, a sheet.
struct GlassSurface<S: InsettableShape>: ViewModifier {
    let shape: S
    var interactive: Bool = true
    var tint: Color? = nil

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            let base: Glass = interactive ? .regular.interactive() : .regular
            content.glassEffect(tint.map { base.tint($0) } ?? base, in: shape)
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .background(tint?.opacity(0.18) ?? .clear, in: shape)
                .overlay(shape.strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.5))
        }
    }
}

extension View {
    /// A capsule of glass — pills and round buttons.
    func glassCapsule(interactive: Bool = true, tint: Color? = nil) -> some View {
        modifier(GlassSurface(shape: Capsule(), interactive: interactive, tint: tint))
    }

    /// A rounded sheet of glass.
    func glassSheet(cornerRadius: CGFloat = 28, tint: Color? = nil) -> some View {
        modifier(GlassSurface(
            shape: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous),
            interactive: false,
            tint: tint
        ))
    }
}

/// Neighbouring glass merges when it touches, the way it does in the
/// system's own bars. A no-op before iOS 26.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 8
    @ViewBuilder let content: () -> Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing, content: content)
        } else {
            content()
        }
    }
}

/// A round glass button with one glyph — the shape of every action in the
/// chrome that is not a pill.
struct GlassButton: View {
    let systemImage: String
    var size: CGFloat = 44
    var weight: Font.Weight = .medium
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.42, weight: weight))
                .foregroundStyle(Color.primary)
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassCapsule()
    }
}
