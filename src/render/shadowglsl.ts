/**
 * Sampling the sun's shadow map from a hand-written shader.
 *
 * The standard materials get shadows from Babylon; the terrain and the water
 * are our own shaders and read the map themselves, with these declarations
 * and functions. A shader using it needs a \`varying vec4 vShadow\` holding
 * the fragment's position in the light's clip space, and its material the
 * uniforms \`setShaderShadow\` sets.
 */
export const SHADOW_GLSL = `
uniform sampler2D shadowSampler;
/**
 * Shadow mode (0 off, 1 float depth, 2 depth packed into RGBA), texels
 * across the map, how much sun a shadow leaves, and the depth bias.
 */
uniform vec4 shadowInfo;

/**
 * One depth from the shadow map. Babylon writes the caster's light-space
 * depth, (z + 1) / 2, either as a float or packed into four bytes when the
 * GPU cannot render to floats; both are read the same way.
 */
float shadowDepth(vec2 uv) {
  vec4 texel = texture2D(shadowSampler, uv);
  if (shadowInfo.x > 1.5) {
    return dot(texel, vec4(1.0 / (255.0 * 255.0 * 255.0), 1.0 / (255.0 * 255.0), 1.0 / 255.0, 1.0));
  }
  return texel.r;
}

/**
 * How much of the sun reaches this point: 1 in the open, 0 fully shadowed.
 *
 * The four nearest depth comparisons, blended by where the point sits among
 * them — what hardware PCF does with a depth texture, which the standard
 * materials' Poisson filter cannot read, so it is done by hand. The edge
 * fades over one texel. A 4x4 kernel softened it further and cost a third of
 * the frame in the software renderer the checks run on; at twenty-odd texels
 * a cell, one texel of fade is already soft.
 */
float sunLit() {
  if (shadowInfo.x < 0.5) return 1.0;
  vec3 clip = vShadow.xyz / vShadow.w;
  vec2 uv = clip.xy * 0.5 + 0.5;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 1.0;
  float depth = clamp(clip.z * 0.5 + 0.5, 0.0, 1.0) - shadowInfo.w;

  float size = shadowInfo.y;
  vec2 at = uv * size - 0.5;
  vec2 f = fract(at);
  vec2 base = (floor(at) + 0.5) / size;
  vec2 step_ = vec2(1.0 / size, 0.0);
  float s00 = step(depth, shadowDepth(base));
  float s10 = step(depth, shadowDepth(base + step_.xy));
  float s01 = step(depth, shadowDepth(base + step_.yx));
  float s11 = step(depth, shadowDepth(base + step_.xx));
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

`;
