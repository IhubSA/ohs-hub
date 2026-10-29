// Starter inspection checklists: general good-practice prompts a
// competent person adapts and approves before use. They are not legal
// requirements and make no compliance claims.
export const STARTERS = [
  { key: 'general', title: 'General workplace inspection', category: 'general', sections: {
    'Access and housekeeping': ['Walkways and aisles are clear of obstructions', 'Floors are clean, dry and in good repair', 'Stairs have handrails and are in good condition', 'Waste is stored and removed properly'],
    'Emergency preparedness': ['Emergency exits are marked, lit and unobstructed', 'Evacuation plan is displayed and current', 'First aid box is stocked and accessible', 'Emergency contact numbers are displayed'],
    'Work environment': ['Lighting is adequate for the work', 'Ventilation is adequate', 'Electrical cords and plugs show no damage', 'Safety signage is displayed where required'],
  } },
  { key: 'fire', title: 'Fire safety inspection', category: 'fire_safety', sections: {
    'Firefighting equipment': ['Fire extinguishers are in place and unobstructed', 'Extinguisher service tags are current', 'Fire hose reels are accessible and in good condition', 'Equipment locations are signposted'],
    'Escape routes': ['Escape routes are clear and doors open easily', 'Emergency lighting works', 'Assembly point signage is visible'],
    'Fire risks': ['Flammable materials are stored correctly', 'No accumulation of combustible waste', 'Hot work areas are controlled'],
  } },
  { key: 'housekeeping', title: 'Housekeeping inspection', category: 'housekeeping', sections: {
    'Work areas': ['Work areas are clean and orderly', 'Materials are stacked safely', 'Tools are stored after use', 'Spills are cleaned up promptly'],
    'Storage': ['Shelving is stable and not overloaded', 'Heavy items are stored at low level', 'Chemicals are labelled and stored correctly'],
  } },
  { key: 'ppe', title: 'PPE compliance inspection', category: 'ppe', sections: {
    'Use of PPE': ['Required PPE is worn in designated areas', 'PPE is in good condition', 'PPE fits the wearer correctly'],
    'PPE management': ['PPE requirements are signposted', 'Replacement PPE is available', 'PPE issue records are up to date'],
  } },
  { key: 'vehicle', title: 'Vehicle pre-use inspection', category: 'vehicles', sections: {
    'Exterior': ['Tyres are in good condition and correctly inflated', 'Lights and indicators work', 'Mirrors and windows are clean and undamaged'],
    'Cab and controls': ['Seatbelts work', 'Brakes and handbrake work', 'Horn works', 'Fire extinguisher and first aid kit present'],
    'Fluids and documents': ['No visible fluid leaks', 'Licence disc is valid', 'Driver holds the required licence'],
  } },
  { key: 'machinery', title: 'Workshop machinery inspection', category: 'machinery', sections: {
    'Guarding': ['Machine guards are fitted and secure', 'Emergency stops are accessible and work', 'Interlocks are working'],
    'Condition': ['Machines are clean and well maintained', 'Electrical connections are safe', 'Maintenance records are current'],
    'Safe operation': ['Operators are trained and authorised', 'Safe work procedures are available at the machine', 'Lockout equipment is available'],
  } },
  { key: 'electrical', title: 'Electrical installation (visual) inspection', category: 'electrical', sections: {
    'Distribution boards': ['Boards are closed, labelled and accessible', 'No exposed live parts', 'Circuits are labelled'],
    'Portable equipment': ['Plugs and cords are undamaged', 'Extension leads are not overloaded', 'No improvised repairs'],
  } },
  { key: 'warehouse', title: 'Warehouse inspection', category: 'warehouses', sections: {
    'Racking': ['Racking is undamaged and secured', 'Load limits are displayed', 'Loads are within limits'],
    'Traffic and equipment': ['Pedestrian and vehicle routes are marked', 'Forklifts have pre-use checks completed', 'Loading bays are safe'],
  } },
  { key: 'construction', title: 'Construction site inspection', category: 'construction', sections: {
    'Site control': ['Site boundaries and access are controlled', 'Site induction records are available', 'Signage is displayed at the entrance'],
    'Work at height': ['Scaffolds are tagged and inspected', 'Edge protection is in place', 'Fall arrest equipment is inspected'],
    'Excavations and plant': ['Excavations are barricaded and supported', 'Plant operators are competent', 'Plant pre-use checks are done'],
  } },
];
export const CATEGORIES = {
  general: 'General workplace', construction: 'Construction site', workshops: 'Workshop', vehicles: 'Vehicles', machinery: 'Machinery',
  electrical: 'Electrical', fire_safety: 'Fire safety', housekeeping: 'Housekeeping', ppe: 'PPE', warehouses: 'Warehouse', equipment: 'Specialised equipment', other: 'Other',
};
