# Closed-loop diabetic-foot insole: CAD model (concept v0.1)
Right insole, 270 x 85 mm, 6.6 mm stack. Units: mm. Z up, toe toward +Y, origin at heel tip.

Layers (bottom to top): 01 base floor (exit holes for tube barbs, underside) / 02 base channels (4 tube grooves, one per bladder) / 03 pneumatic layer (4 bladder cavities with 2.5 mm weld seams) / 04 sensor layer (11 sensor pockets, 6 temperature pockets) / 05 top cover.
Parts: 4 bladder bodies (neutral height 2.2 mm), FSR discs, temperature sensors, and a separate control-box enclosure with placeholder components (MCU, battery, pump, 4 valves, sensor boards).

Files: stl/ (all parts and insole_assembly.stl), svg/ (layer outlines in mm, for sketching in any CAD), parameters.json, plan_view.png.
All meshes pass a watertight check. These are STL meshes, not parametric STEP files: import into Fusion/SolidWorks/Onshape as meshes or use the SVG outlines as sketches.

Assumptions to replace: foot outline is a schematic shape (use a patient scan later); sensor pocket 14.0 mm is sized for a FlexiForce-class sensor head; layer thicknesses and the control-box layout are placeholders. Not a validated medical design.
