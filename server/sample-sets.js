// Two ready-to-run science sets so the teacher can try the quiz with zero prep.
// Written as CSV on purpose: this is exactly what a teacher pastes into /admin,
// so the samples double as a worked example of the format.

export const SAMPLE_SETS = [
  {
    name: 'Cells & Energy (4 options)',
    csv: [
      'question,a,b,c,d,correct,topic',
      'Which organelle releases energy from food?,Ribosome,Mitochondrion,Golgi body,Vacuole,B,cells',
      'What gas do plants take in for photosynthesis?,Oxygen,Nitrogen,Carbon dioxide,Hydrogen,C,photosynthesis',
      'Where does photosynthesis happen in a plant cell?,Nucleus,Chloroplast,Cell wall,Lysosome,B,photosynthesis',
      'What is the main energy molecule cells spend?,ATP,DNA,RNA,NaCl,A,cells',
      '"Photosynthesis stores energy, and respiration does what?",Stores more energy,Releases energy,Destroys atoms,Creates matter,B,energy',
      'Which part controls what enters and leaves the cell?,Cell membrane,Nucleus,Ribosome,Cytoplasm,A,cells',
      'Plant cells have a rigid outer layer called the what?,Membrane,Cell wall,Capsule,Shell,B,cells',
      'What do we call organisms that make their own food?,Consumers,Producers,Decomposers,Predators,B,energy',
    ].join('\n'),
  },
  {
    name: 'Forces & Motion (2 options)',
    csv: [
      'question,a,b,c,d,correct,topic',
      'A force can change the motion of an object.,True,False,,,A,forces',
      'Gravity pulls objects toward the centre of the Earth.,True,False,,,A,gravity',
      'Heavier objects always fall faster in a vacuum.,True,False,,,B,gravity',
      'Friction acts in the same direction as motion.,True,False,,,B,forces',
      'An object at rest stays at rest unless a force acts on it.,True,False,,,A,newton',
      'Speed tells you direction as well as how fast.,True,False,,,B,motion',
      'Every action has an equal and opposite reaction.,True,False,,,A,newton',
      'A ball rolling on carpet slows down because of friction.,True,False,,,A,forces',
    ].join('\n'),
  },
];
