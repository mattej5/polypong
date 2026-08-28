// Ready-to-run science sets so the app is usable the moment a teacher opens
// it, with zero prep. Written as CSV on purpose: this is exactly what a
// teacher would paste into the question-set panel, so these sets double as
// a worked example of the format documented in SPEC §6.5.

import type { QuestionSetRecord } from './match';

const BIOLOGY_CSV = [
  'question,optionA,optionB,optionC,optionD,correct',
  'Which organelle is known as the powerhouse of the cell?,Nucleus,Mitochondrion,Ribosome,Golgi apparatus,B',
  'What pigment do plants use to capture light energy?,Chlorophyll,Melanin,Hemoglobin,Keratin,A',
  'What is the basic unit of life?,Atom,Molecule,Cell,Tissue,C',
  'Which gas do plants release during photosynthesis?,Carbon dioxide,Oxygen,Nitrogen,Methane,B',
  'DNA is found mainly in which part of the cell?,Cytoplasm,Nucleus,Cell wall,Vacuole,B',
  'What process do cells use to divide and make copies of themselves?,Osmosis,Mitosis,Diffusion,Photosynthesis,B',
  'Which of these is a producer in a food chain?,Grass,Rabbit,Fox,Mushroom,A',
  "What do we call an organism's habitat plus its role in the ecosystem?,Biome,Niche,Population,Community,B",
].join('\r\n');

const CHEMISTRY_CSV = [
  'question,optionA,optionB,optionC,optionD,correct',
  'What is the smallest unit of an element that keeps its properties?,Molecule,Atom,Proton,Compound,B',
  'What do we call a substance made of two or more elements chemically combined?,Mixture,Compound,Solution,Suspension,B',
  '"On the periodic table, elements in the same column share what?",Atomic mass,Number of protons,Similar chemical properties,Color,C',
  'What is the pH of a neutral solution?,0,7,14,10,B',
  'Which particle has a negative charge?,Proton,Neutron,Electron,Nucleus,C',
  'What type of reaction releases heat?,Endothermic,Exothermic,Neutral,Catalytic,B',
  'What is the chemical symbol for sodium?,S,So,Na,Nd,C',
  'Water is made of hydrogen and what other element?,Oxygen,Nitrogen,Carbon,Helium,A',
  'What state of matter has a definite volume but no definite shape?,Solid,Liquid,Gas,Plasma,B',
].join('\r\n');

// Includes two true/false rows (blank C and D) so the two-option path is
// exercised by a real, usable set, not just a test fixture.
const EARTH_SCIENCE_CSV = [
  'question,optionA,optionB,optionC,optionD,correct',
  'What layer of Earth do we live on?,Core,Mantle,Crust,Atmosphere,C',
  'Earth orbits the Sun once approximately every 365 days.,True,False,,,A',
  "What causes the tides on Earth?,The Sun only,The Moon's gravity,Wind,Ocean currents,B",
  'Which type of rock forms from cooled lava or magma?,Sedimentary,Metamorphic,Igneous,Mineral,C',
  'The ozone layer protects Earth from harmful UV radiation.,True,False,,,A',
  'What is the water cycle process where water rises into the air as vapor?,Condensation,Evaporation,Precipitation,Collection,B',
  'Which layer of the atmosphere do we breathe in?,Stratosphere,Troposphere,Mesosphere,Exosphere,B',
  'Earthquakes are most common along what kind of boundary?,Plate boundaries,Ocean floors,Mountain peaks,Deserts,A',
  "Most of Earth's fresh water is stored as what?,Rivers,Lakes,Ice caps and glaciers,Groundwater,C",
].join('\r\n');

export const SAMPLE_SETS: readonly QuestionSetRecord[] = [
  { id: 'sample-biology', name: 'Biology Basics', csv: BIOLOGY_CSV },
  { id: 'sample-chemistry', name: 'Chemistry Basics', csv: CHEMISTRY_CSV },
  { id: 'sample-earth-science', name: 'Earth Science Basics', csv: EARTH_SCIENCE_CSV },
];
