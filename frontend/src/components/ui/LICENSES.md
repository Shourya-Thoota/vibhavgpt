# Third-party notices for `components/ui`

Two components in this folder were supplied from outside the project. Their
attribution is kept here and in the header comment of each file.

## `liquid-glass-logo-reveal.tsx`

The shader and the spring timeline are ported from
[zanwei/glass-icon-reveal](https://github.com/zanwei/glass-icon-reveal),
which is released under the MIT licence:

```
MIT License

Copyright (c) 2026 Zanwei Guo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The component as supplied is the "21st.dev Glass Reveal". Here it is adapted
in three ways, listed at the top of the file: `GlassIconReveal` and its props
are exported, the 21st.dev mark and wrapper are replaced by the VibhavGPT logo
and `GlassRevealVibhavGPT`, and the header note. The reveal engine, shader and
timeline are otherwise as supplied.

## `tilted-grid-hero.tsx`

Supplied as the "Scroll Tilted Grid, turned on its side" hero component. The
source came with no licence text, so none is reproduced here. Its header
comment is kept exactly as supplied. If a licence is later published for it,
add it to this file.

## `orbit-showcase.tsx`

Adapted from a supplied "Dish Orbit Carousel" component (React, GSAP and its ScrollTrigger plugin). The supplied source came
with no licence text, so none is reproduced here. What changed is listed in the header comment of the file: the food content,
rating, chef, likes and the embedded font are gone, and the data, links, colours and artwork are this project's own.

It depends on **GSAP 3.15.1** (the `gsap` package on npm, pinned exactly in `frontend/package.json`). GSAP is not part of this
repository; it is installed from npm and bundled into one lazily loaded chunk of the home page. It is **not** MIT. It is released
under the GSAP "Standard 'no charge' license", `https://gsap.com/standard-license`, owned by Webflow, Inc. (GreenSock). From the
terms as published when it was added (2026-11-07):

- Use is free of charge, in commercial and non-commercial websites, web applications and digital interfaces. All plugins,
  including ones that were once members-only, are covered. The published FAQ says commercial projects need no payment.
- The one prohibited use is putting GSAP in a tool that lets users build visual animations without code and so competes with
  Webflow's visual animation builder. VibhavGPT is not such a tool.
- Intellectual property in GSAP stays with Webflow. Webflow may terminate the licence if its terms are broken, and may update the
  terms by posting them.

Compatibility with this repository's own licence (AGPL-3.0-only) has not been settled. The GSAP licence is a free-to-use
proprietary licence, not an open-source one, and it adds restrictions of its own. Whether bundling it fits the AGPL is a
decision for the owner (and counsel if wanted); it is recorded here so it is not forgotten.

## `splash-cursor.jsx` and `splash-cursor.css`

`SplashCursor` from [React Bits](https://reactbits.dev) (JavaScript + CSS variant), added as supplied. It is the home page's
background, loaded lazily and skipped for readers who ask for reduced motion or to save data. React Bits publishes it under
"MIT + Commons Clause", copyright David Haz. The licence, as published at
`https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md` when the component was added (2026-11-07):

```
MIT + Commons Clause License Condition v1.0

Copyright (c) 2026 David Haz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, and distribute the Software **as part of an application, website, or product**, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

## Commons Clause Restriction

You may use this Software, including for any commercial purpose, **so long as you do not sell, sublicense, or redistribute the components themselves-whether alone, in a bundle, or as a ported version.**

The same restriction covers the React Bits tools (Background Studio, Texture Lab, Shape Magic, Center Stage, Sound Lab and any tools added later) and the sounds in the sound library. **You may not sell, sublicense, or redistribute the tools or the sounds themselves, or offer the tools or a substantially similar copy of them as a hosted service-whether alone, in a bundle, or as a ported version.**

What you make with the tools is yours to use. You can use exported code, images, videos, and audio files in any personal or commercial application, website, or product, including paid ones. **You may not sell or redistribute the exports on their own, either individually or as the product itself, such as a sound, texture, background, or template pack.**

## No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

What this allows here: the component is used as part of this website, including a commercial one. What it does not allow is
selling, sublicensing or redistributing the component itself, alone, in a bundle or as a ported version.

An open question for the owner: this repository is AGPL-3.0-only and its source is published, and the AGPL lets anyone who
receives the source pass it on. Whether publishing this file in the source repository counts as redistributing the component
itself under the Commons Clause, or as distributing it "as part of an application, website, or product", is not settled here,
and the Commons Clause is not an open-source condition. Decide before the file is published, and whether to keep it out of the
public mirror. (Counsel if wanted; this note is not legal advice.)
