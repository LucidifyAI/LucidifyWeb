/*  yasa_dsp.js
    DSP utilities for YASA-like staging in pure JS.

    Implements:
      - Downsample/resample helpers (target 100 Hz)
      - Simple Butterworth-ish bandpass (0.4–30 Hz) via RBJ biquads
      - Welch PSD with Hamming window, median averaging
      - Bandpower integration helpers

    License note:
      This file is an original implementation for compatibility.
*/
(function () {
  "use strict";
    // ------------------------- DEBUG EXPORTS (one-shot) -------------------------
  // Set true when you want JSON downloads of intermediate signals.
  const __DEBUG_EXPORTS__ = true;

  // Only export once per page load to avoid spam.
  let __didExportDownsampleOnly__ = false;
  let __didExportBandpass__ = false;

  function __debugExportJson(filename, obj) {
    if (!__DEBUG_EXPORTS__) return;

    // Browser download (most common for LucidifyWeb)
    try {
      const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      console.log(`[DEBUG] wrote ${filename} (${(blob.size / 1024).toFixed(1)} KB)`);
      return;
    } catch (e) {
      // ignore, maybe not in DOM environment
    }

    // Node fallback (if you ever run this in Node)
    try {
      const fs = require("fs");
      fs.writeFileSync(filename, JSON.stringify(obj));
      console.log(`[DEBUG] wrote ${filename} (node)`);
    } catch (e) {
      console.warn(`[DEBUG] could not export ${filename}:`, e);
    }
  }

  function __firstEpochJson(xF64, fs) {
    const nEpoch = 30 * fs; // 3000 at fs=100
    const n = Math.min(nEpoch, xF64.length);
    return { fs, signal: Array.from(xF64.slice(0, n)) };
  }
  const __MNE_FIR_0P4_30_FS100__ = {
	  fs: 100.0,
	  l_freq: 0.4,
	  h_freq: 30.0,
	  num_taps: 825,
	  taps: [5.552491065237147e-05, 5.6015832647250754e-05, 5.6519279620690065e-05, 5.703561502745966e-05, 5.756518802911229e-05, 5.810833312970117e-05, 5.866536981588186e-05, 5.923660220156079e-05, 5.982231867725178e-05, 6.042279156430129e-05, 6.103827677414034e-05, 6.166901347272143e-05, 6.231522375029569e-05, 6.297711229668567e-05, 6.365486608220576e-05, 6.434865404438225e-05, 6.505862678062214e-05, 6.578491624697915e-05, 6.652763546316215e-05, 6.728687822393093e-05, 6.806271881702152e-05, 6.885521174774056e-05, 6.966439147036772e-05, 7.049027212650241e-05, 7.13328472904878e-05, 7.219208972204517e-05, 7.306795112624684e-05, 7.396036192095614e-05, 7.486923101185807e-05, 7.579444557520419e-05, 7.673587084839066e-05, 7.769334992848757e-05, 7.866670357883397e-05, 7.965573004381131e-05, 8.066020487190441e-05, 8.167988074715686e-05, 8.271448732912548e-05, 8.376373110143439e-05, 8.482729522902765e-05, 8.590483942421584e-05, 8.699599982160943e-05, 8.810038886202785e-05, 8.921759518547195e-05, 9.034718353324316e-05, 9.14886946592885e-05, 9.26416452508511e-05, 9.380552785849826e-05, 9.497981083559975e-05, 9.616393828732257e-05, 9.735733002920784e-05, 9.855938155539031e-05, 9.976946401651869e-05, 0.00010098692420743122, 0.00010221108456463683, 0.00010344124317365134, 0.0001046766737862305, 0.00010591662584754304, 0.00010716032453331865, 0.00010840697079700751, 0.00010965574142697763, 0.00011090578911378097, 0.00011215624252750835, 0.00011340620640525319, 0.00011465476164870158, 0.00011590096543185847, 0.00011714385131892027, 0.00011838242939229834, 0.0001196156863907946, 0.0001208425858579266, 0.0001220620683003961, 0.00012327305135669244, 0.0001244744299758145, 0.0001256650766060979, 0.00012684384139412236, 0.00012800955239367865, 0.00012916101578476326, 0.00013029701610257175, 0.0001314163164764525, 0.00013251765887878326, 0.00013359976438372735, 0.00013466133343582014, 0.00013570104612833936, 0.0001367175624914012, 0.00013770952278972716, 0.00013867554783001792, 0.0001396142392778714, 0.0001405241799841729, 0.00014140393432088893, 0.00014225204852618556, 0.0001430670510587921, 0.0001438474529615294, 0.00014459174823391188, 0.00014529841421373718, 0.00014596591196756645, 0.00014659268669000067, 0.00014717716811164937, 0.00014771777091569042, 0.00014821289516291233, 0.0001486609267251271, 0.0001490602377268403, 0.000149409186995062, 0.00014970612051713552, 0.00014994937190646103, 0.00015013726287598699, 0.00015026810371933846, 0.00015034019379944863, 0.00015035182204455814, 0.00015030126745144037, 0.00015018679959571097, 0.00015000667914907744, 0.00014975915840337761, 0.00014944248180125634, 0.00014905488647332766, 0.00014859460278166204, 0.00014805985486944246, 0.0001474488612166247, 0.00014675983520143562, 0.00014599098566754414, 0.0001451405174967331, 0.00014420663218689975, 0.00014318752843520753, 0.00014208140272621583, 0.0001408864499248022, 0.0001396008638736999, 0.0001382228379954634, 0.00013675056589867445, 0.00013518224198820388, 0.00013351606207933402, 0.000131750224015552, 0.00012988292828981692, 0.00012791237866910824, 0.00012583678282205186, 0.00012365435294942856, 0.00012136330641736062, 0.00011896186639297474, 0.00011644826248233507, 0.00011382073137044163, 0.00011107751746308637, 0.00010821687353035613, 0.00010523706135157555, 0.00010213635236147562, 9.891302829737722e-05, 9.55653818471757e-05, 9.209171729791118e-05, 8.849035118471148e-05, 8.475961293988875e-05, 8.089784554197519e-05, 7.6903406164478e-05, 7.277466682413832e-05, 6.851001502847238e-05, 6.410785442237755e-05, 5.956660543358316e-05, 5.488470591672524e-05, 5.0060611795827864e-05, 4.5092797704966814e-05, 3.9979757626898444e-05, 3.472000552943175e-05, 2.931207599932288e-05, 2.375452487347443e-05, 1.8045929867215884e-05, 1.2184891199448325e-05, 6.170032214431826e-06, -6.089006520692111e-20, -6.326533998021425e-06, -1.28108733654053e-05, -1.9454296113343393e-05, -2.625805407671178e-05, -3.322337231699474e-05, -4.035144853008606e-05, -4.7643452459177666e-05, -5.510052531295161e-05, -6.272377918928231e-05, -7.051429650466531e-05, -7.847312942957675e-05, -8.660129932997531e-05, -9.489979621514778e-05, -0.00010336957819211066, -0.00011201157092676272, -0.00012082666711199737, -0.0001298157259429707, -0.0001389795725997243, -0.00014831899773736157, -0.00015783475698396654, -0.0001675275704464645, -0.0001773981222246101, -0.00018744705993329388, -0.00019767499423334995, -0.00020808249837105377, -0.00021867010772648753, -0.00022943831937095342, -0.00024038759163361406, -0.0002515183436775278, -0.00026283095508525885, -0.00027432576545422557, -0.0002860030740019538, -0.0002978631391814031, -0.0003099061783065175, -0.0003221323671881704, -0.00033454183978064834, -0.0003471346878388314, -0.00035991096058621605, -0.0003728706643939273, -0.00038601376247086335, -0.0003993401745651097, -0.0004128497766767622, -0.0004265424007822873, -0.00044041783457055185, -0.00045447582119064844, -0.00046871605901163595, -0.0004831382013943175, -0.0004977418564751688, -0.0005125265869625269, -0.0005274919099451529, -0.0005426372967132666, -0.0005579621725921581, -0.0005734659167884691, -0.0005891478622492407, -0.0006050072955338131, -0.0006210434566986657, -0.0006372555391952766, -0.0006536426897810762, -0.0006702040084435736, -0.000686938548337722, -0.0007038453157365859, -0.0007209232699953757, -0.0007381713235289012, -0.0007555883418025008, -0.0007731731433364935, -0.000790924499724198, -0.0008088411356635552, -0.0008269217290023969, -0.0008451649107973863, -0.0008635692653866605, -0.0008821333304761968, -0.0009008555972399181, -0.0009197345104335587, -0.0009387684685222955, -0.0009579558238221479, -0.0009772948826551556, -0.0009967839055183207, -0.0010164211072663132, -0.001036204657307928, -0.0010561326798162725, -0.0010762032539526692, -0.0010964144141042426, -0.0011167641501351635, -0.0011372504076515196, -0.0011578710882797672, -0.0011786240499587284, -0.0011995071072450792, -0.001220518031632283, -0.0012416545518829114, -0.0012629143543742896, -0.0012842950834574094, -0.0013057943418290257, -0.0013274096909168824, -0.0013491386512779766, -0.00137097870300978, -0.0013929272861743418, -0.0014149818012351672, -0.0014371396095067923, -0.001459398033616944, -0.0014817543579811908, -0.0015042058292899735, -0.001526749657007903, -0.0015493830138852143, -0.0015721030364812558, -0.0015949068256998857, -0.0016177914473366575, -0.0016407539326376574, -0.0016637912788698534, -0.001686900449902833, -0.0017100783768017654, -0.001733321958431465, -0.0017566280620713805, -0.0017799935240413794, -0.001803415150338151, -0.0018268897172820826, -0.0018504139721744275, -0.001873984633964612, -0.0018975983939274973, -0.0019212519163504282, -0.0019449418392298884, -0.0019686647749775758, -0.0019924173111357194, -0.0020161960111014484, -0.0020399974148600057, -0.002063818039726646, -0.0020876543810969803, -0.0021115029132055983, -0.0021353600898927397, -0.00215922234537883, -0.0021830860950466584, -0.0022069477362309828, -0.002230803649015363, -0.0022546501970359843, -0.0022784837282922694, -0.0023023005759640488, -0.002326097059235056, -0.0023498694841225447, -0.002373614144312765, -0.0023973273220021045, -0.002421005288743629, -0.0024446443062988025, -0.002468240627494149, -0.0024917904970826153, -0.0025152901526093864, -0.0025387358252819173, -0.002562123740843945, -0.0025854501204532108, -0.0026087111815626673, -0.0026319031388049147, -0.002655022204879605, -0.0026780645914435794, -0.002701026510003475, -0.0027239041728105446, -0.0027466937937574475, -0.0027693915892767376, -0.0027919937792408073, -0.0028144965878630166, -0.0028368962445997612, -0.0028591889850532117, -0.00288137105187446, -0.002903438695666832, -0.0029253881758890808, -0.0029472157617582203, -0.0029689177331517266, -0.002990490381508848, -0.0030119300107307634, -0.0030332329380793306, -0.003054395495074161, -0.0030754140283877495, -0.003096284900738424, -0.0031170044917808266, -0.0031375691989936876, -0.0031579754385646142, -0.0031782196462716546, -0.003198298278361369, -0.0032182078124231442, -0.003237944748259512, -0.0032575056087522005, -0.003276886940723673, -0.0032960853157938974, -0.0033150973312320925, -0.003333919610803208, -0.003352548805608882, -0.0033709815949226236, -0.0033892146870189905, -0.003407244819996495, -0.003425068762594016, -0.00344268331500046, -0.003460085309657438, -0.003477271612054722, -0.003494239121518245, -0.0035109847719904, -0.003527505532802423, -0.003543798409438627, -0.0035598604442922425, -0.003575688717412665, -0.0035912803472438705, -0.003606632491353786, -0.003621742347154392, -0.003636607152612353, -0.00365122418694995, -0.0036655907713361202, -0.0036797042695673834, -0.003693562088738469, -0.0037071616799024213, -0.0037205005387200116, -0.0037335762060982363, -0.003746386268817736, -0.0037589283601489197, -0.003771200160456644, -0.0037831993977932234, -0.003794923848479646, -0.003806371337674765, -0.0038175397399323394, -0.003828426979745737, -0.003839031032080135, -0.0038493499228920624, -0.003859381729636139, -0.0038691245817588336, -0.003878576661179116, -0.003887736202755851, -0.0038966014947417896, -0.003905170879224027, -0.003913442752550787, -0.003921415565744421, -0.003929087824900471, -0.003936458091572704, -0.0034185945035425545, -0.0032803326335970853, -0.005524869510840454, -0.0028998684193222513, -0.0027415206622619544, -0.007561020651732367, -0.0011904410491568036, -0.0016212819835313853, -0.011815929503382061, 0.002526000445104948, -0.00011165222737116775, -0.019179100840544222, 0.009609005536588692, 0.0015153425749066104, -0.031645984743017504, 0.023229966572170406, 0.0029596474590855727, -0.05616834004851342, 0.055597190687680716, 0.00395148858363101, -0.14303718631900897, 0.26582556630017073, 0.6702615166968056, 0.26582556630017073, -0.14303718631900897, 0.00395148858363101, 0.055597190687680716, -0.05616834004851342, 0.0029596474590855727, 0.023229966572170403, -0.0316459847430175, 0.0015153425749066104, 0.009609005536588692, -0.019179100840544222, -0.00011165222737116775, 0.00252600044510495, -0.011815929503382063, -0.001621281983531384, -0.0011904410491568053, -0.007561020651732364, -0.0027415206622619552, -0.0028998684193222513, -0.005524869510840454, -0.003280332633597086, -0.0034185945035425545, -0.003936458091572704, -0.003929087824900471, -0.003921415565744421, -0.003913442752550788, -0.003905170879224027, -0.00389660149474179, -0.003887736202755851, -0.003878576661179116, -0.0038691245817588336, -0.0038593817296361395, -0.0038493499228920624, -0.003839031032080135, -0.0038284269797457375, -0.0038175397399323394, -0.003806371337674765, -0.003794923848479646, -0.0037831993977932243, -0.003771200160456644, -0.00375892836014892, -0.003746386268817736, -0.0037335762060982367, -0.0037205005387200116, -0.0037071616799024213, -0.0036935620887384698, -0.0036797042695673834, -0.003665590771336121, -0.00365122418694995, -0.003636607152612353, -0.003621742347154392, -0.003606632491353786, -0.0035912803472438705, -0.003575688717412665, -0.003559860444292243, -0.003543798409438627, -0.0035275055328024235, -0.0035109847719904, -0.0034942391215182452, -0.003477271612054722, -0.003460085309657438, -0.0034426833150004604, -0.003425068762594016, -0.0034072448199964954, -0.0033892146870189905, -0.003370981594922624, -0.003352548805608882, -0.0033339196108032087, -0.0033150973312320925, -0.0032960853157938974, -0.0032768869407236736, -0.0032575056087522005, -0.0032379447482595125, -0.0032182078124231442, -0.003198298278361369, -0.0031782196462716546, -0.003157975438564615, -0.0031375691989936876, -0.003117004491780827, -0.003096284900738424, -0.0030754140283877495, -0.003054395495074162, -0.0030332329380793306, -0.003011930010730764, -0.002990490381508848, -0.002968917733151727, -0.0029472157617582203, -0.002925388175889081, -0.002903438695666832, -0.0028813710518744606, -0.0028591889850532117, -0.0028368962445997612, -0.0028144965878630166, -0.0027919937792408073, -0.002769391589276738, -0.0027466937937574475, -0.002723904172810545, -0.002701026510003475, -0.0026780645914435803, -0.0026550222048796054, -0.0026319031388049147, -0.0026087111815626678, -0.0025854501204532108, -0.002562123740843945, -0.0025387358252819173, -0.0025152901526093864, -0.0024917904970826153, -0.00246824062749415, -0.002444644306298803, -0.002421005288743629, -0.0023973273220021045, -0.002373614144312765, -0.0023498694841225447, -0.0023260970592350566, -0.002302300575964049, -0.0022784837282922694, -0.0022546501970359843, -0.0022308036490153635, -0.0022069477362309836, -0.002183086095046659, -0.00215922234537883, -0.0021353600898927397, -0.002111502913205599, -0.0020876543810969808, -0.002063818039726646, -0.0020399974148600057, -0.002016196011101449, -0.0019924173111357207, -0.001968664774977576, -0.0019449418392298884, -0.0019212519163504282, -0.001897598393927498, -0.0018739846339646126, -0.0018504139721744275, -0.0018268897172820826, -0.0018034151503381515, -0.0017799935240413796, -0.001756628062071381, -0.001733321958431465, -0.0017100783768017654, -0.0016869004499028332, -0.0016637912788698538, -0.0016407539326376574, -0.0016177914473366575, -0.0015949068256998864, -0.0015721030364812562, -0.0015493830138852147, -0.001526749657007903, -0.0015042058292899735, -0.0014817543579811912, -0.0014593980336169443, -0.0014371396095067925, -0.0014149818012351672, -0.0013929272861743424, -0.0013709787030097805, -0.0013491386512779768, -0.0013274096909168824, -0.0013057943418290257, -0.0012842950834574096, -0.0012629143543742896, -0.0012416545518829114, -0.001220518031632283, -0.0011995071072450798, -0.0011786240499587289, -0.0011578710882797672, -0.0011372504076515196, -0.0011167641501351633, -0.0010964144141042428, -0.0010762032539526694, -0.0010561326798162725, -0.001036204657307928, -0.0010164211072663137, -0.000996783905518321, -0.0009772948826551559, -0.0009579558238221479, -0.0009387684685222954, -0.000919734510433559, -0.0009008555972399182, -0.0008821333304761968, -0.0008635692653866605, -0.0008451649107973865, -0.000826921729002397, -0.0008088411356635554, -0.000790924499724198, -0.0007731731433364939, -0.0007555883418025009, -0.0007381713235289014, -0.0007209232699953757, -0.0007038453157365859, -0.0006869385483377225, -0.0006702040084435738, -0.0006536426897810763, -0.0006372555391952766, -0.000621043456698666, -0.0006050072955338133, -0.0005891478622492408, -0.0005734659167884691, -0.000557962172592158, -0.0005426372967132668, -0.000527491909945153, -0.000512526586962527, -0.0004977418564751688, -0.00048313820139431776, -0.0004687160590116361, -0.0004544758211906485, -0.00044041783457055185, -0.0004265424007822872, -0.00041284977667676236, -0.00039934017456510985, -0.00038601376247086346, -0.0003728706643939273, -0.00035991096058621627, -0.00034713468783883155, -0.00033454183978064834, -0.0003221323671881704, -0.00030990617830651743, -0.0002978631391814032, -0.00028600307400195393, -0.0002743257654542257, -0.00026283095508525885, -0.00025151834367752795, -0.00024038759163361417, -0.00022943831937095348, -0.00021867010772648753, -0.0002080824983710537, -0.00019767499423335003, -0.00018744705993329393, -0.00017739812222461015, -0.0001675275704464645, -0.00015783475698396662, -0.00014831899773736165, -0.00013897957259972432, -0.0001298157259429707, -0.00012082666711199736, -0.00011201157092676277, -0.00010336957819211069, -9.48997962151478e-05, -8.660129932997531e-05, -7.84731294295768e-05, -7.051429650466535e-05, -6.272377918928234e-05, -5.510052531295161e-05, -4.764345245917766e-05, -4.035144853008608e-05, -3.3223372316994757e-05, -2.625805407671178e-05, -1.9454296113343393e-05, -1.281087336540531e-05, -6.326533998021427e-06, -6.089006520692113e-20, 6.170032214431826e-06, 1.2184891199448322e-05, 1.8045929867215895e-05, 2.3754524873474433e-05, 2.931207599932288e-05, 3.472000552943175e-05, 3.997975762689848e-05, 4.509279770496684e-05, 5.006061179582787e-05, 5.488470591672524e-05, 5.956660543358321e-05, 6.410785442237758e-05, 6.851001502847238e-05, 7.277466682413832e-05, 7.6903406164478e-05, 8.089784554197528e-05, 8.47596129398888e-05, 8.849035118471148e-05, 9.209171729791118e-05, 9.55653818471758e-05, 9.891302829737728e-05, 0.00010213635236147562, 0.00010523706135157555, 0.00010821687353035613, 0.0001110775174630865, 0.00011382073137044173, 0.00011644826248233507, 0.00011896186639297474, 0.00012136330641736073, 0.00012365435294942864, 0.00012583678282205186, 0.00012791237866910824, 0.00012988292828981692, 0.00013175022401555204, 0.0001335160620793341, 0.00013518224198820388, 0.00013675056589867445, 0.00013822283799546354, 0.00013960086387369998, 0.0001408864499248022, 0.00014208140272621583, 0.00014318752843520753, 0.00014420663218689986, 0.00014514051749673322, 0.00014599098566754414, 0.00014675983520143562, 0.00014744886121662487, 0.0001480598548694426, 0.00014859460278166204, 0.00014905488647332766, 0.00014944248180125634, 0.00014975915840337767, 0.00015000667914907753, 0.00015018679959571097, 0.00015030126745144037, 0.00015035182204455838, 0.00015034019379944877, 0.00015026810371933846, 0.00015013726287598699, 0.00014994937190646103, 0.00014970612051713562, 0.00014940918699506213, 0.0001490602377268403, 0.0001486609267251271, 0.00014821289516291254, 0.0001477177709156905, 0.00014717716811164937, 0.00014659268669000067, 0.00014596591196756645, 0.00014529841421373726, 0.00014459174823391196, 0.0001438474529615294, 0.0001430670510587921, 0.00014225204852618564, 0.00014140393432088906, 0.0001405241799841729, 0.0001396142392778714, 0.00013867554783001792, 0.00013770952278972727, 0.00013671756249140132, 0.00013570104612833936, 0.00013466133343582014, 0.00013359976438372744, 0.0001325176588787834, 0.0001314163164764525, 0.00013029701610257175, 0.00012916101578476345, 0.00012800955239367873, 0.0001268438413941224, 0.0001256650766060979, 0.0001244744299758145, 0.00012327305135669252, 0.0001220620683003962, 0.0001208425858579266, 0.0001196156863907946, 0.00011838242939229847, 0.00011714385131892036, 0.00011590096543185852, 0.00011465476164870158, 0.00011340620640525319, 0.00011215624252750839, 0.00011090578911378107, 0.00010965574142697763, 0.00010840697079700751, 0.00010716032453331886, 0.0001059166258475431, 0.00010467667378623056, 0.00010344124317365134, 0.00010221108456463683, 0.00010098692420743127, 9.976946401651874e-05, 9.855938155539031e-05, 9.735733002920784e-05, 9.616393828732267e-05, 9.497981083559981e-05, 9.380552785849831e-05, 9.26416452508511e-05, 9.14886946592885e-05, 9.03471835332432e-05, 8.9217595185472e-05, 8.810038886202785e-05, 8.699599982160943e-05, 8.590483942421594e-05, 8.48272952290277e-05, 8.376373110143439e-05, 8.271448732912548e-05, 8.167988074715686e-05, 8.066020487190445e-05, 7.965573004381137e-05, 7.866670357883397e-05, 7.769334992848757e-05, 7.673587084839072e-05, 7.579444557520423e-05, 7.486923101185807e-05, 7.396036192095614e-05, 7.306795112624684e-05, 7.219208972204521e-05, 7.133284729048784e-05, 7.049027212650241e-05, 6.966439147036772e-05, 6.885521174774056e-05, 6.806271881702157e-05, 6.728687822393093e-05, 6.652763546316215e-05, 6.578491624697915e-05, 6.505862678062214e-05, 6.434865404438225e-05, 6.365486608220576e-05, 6.297711229668567e-05, 6.231522375029569e-05, 6.166901347272143e-05, 6.103827677414034e-05, 6.042279156430129e-05, 5.982231867725178e-05, 5.923660220156079e-05, 5.866536981588186e-05, 5.810833312970117e-05, 5.756518802911229e-05, 5.703561502745966e-05, 5.6519279620690065e-05, 5.6015832647250754e-05, 5.552491065237147e-05]
	};
  const MNE_FIR_0P4_30_FS100 = __MNE_FIR_0P4_30_FS100__;
    // ------------------------- MNE FIR (0.4–30 Hz @ 100 Hz) loader -------------------------
console.log("MNE taps len", __MNE_FIR_0P4_30_FS100__.taps.length);
  let __mneFirTapsF64 = null;

async function __loadMneFirTapsOnce() {
  if (__mneFirTapsF64) return __mneFirTapsF64;

  // embedded const (not window)
  const taps = __MNE_FIR_0P4_30_FS100__?.taps;
  if (!taps || taps.length !== 825) {
    throw new Error(`Embedded MNE FIR taps missing/invalid (len=${taps ? taps.length : "null"})`);
  }

  __mneFirTapsF64 = Float64Array.from(taps);
  return __mneFirTapsF64;
}


  function __firConvolveSame(x, h) {
    const n = x.length;
    const m = h.length;
    const y = new Float64Array(n);
    const half = (m - 1) >> 1;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = 0; k < m; k++) {
        const xi = i + k - half;
        if (xi >= 0 && xi < n) acc += x[xi] * h[k];
      }
      y[i] = acc;
    }
    return y;
  }

  function __filtfiltFIR_reflectSame(x, h) {
    const n = x.length;
    const m = h.length;
    const pad = Math.min(n - 1, 3 * (m - 1));
    if (pad <= 0) return __firConvolveSame(x, h);

    const xp = new Float64Array(n + 2 * pad);

    // left reflect
    for (let i = 0; i < pad; i++) xp[i] = x[pad - i];
    // center
    for (let i = 0; i < n; i++) xp[pad + i] = x[i];
    // right reflect
    for (let i = 0; i < pad; i++) xp[pad + n + i] = x[n - 2 - i];

    const y1 = __firConvolveSame(xp, h);

    // reverse
    const yr = new Float64Array(y1.length);
    for (let i = 0; i < y1.length; i++) yr[i] = y1[y1.length - 1 - i];

    const y2 = __firConvolveSame(yr, h);

    // reverse back
    const y = new Float64Array(y2.length);
    for (let i = 0; i < y2.length; i++) y[i] = y2[y2.length - 1 - i];

    return y.subarray(pad, pad + n);
  }

  async function bandpassMNE_04_30_zeroPhase_fs100_async(x, fs) {
    if (fs !== 100) throw new Error(`bandpassMNE_04_30_zeroPhase_fs100_async expects fs=100, got ${fs}`);
    const h = await __loadMneFirTapsOnce();
    return __filtfiltFIR_reflectSame(x, h);
  }
  // ------------------------- small math helpers -------------------------
  function clamp(x, a, b) { return Math.min(Math.max(x, a), b); }

  function mean(x) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i];
    return x.length ? (s / x.length) : 0;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = Array.from(arr);
    a.sort((p, q) => p - q);
    const m = a.length >> 1;
    return (a.length & 1) ? a[m] : 0.5 * (a[m - 1] + a[m]);
  }
// Expected value of the sample median for n iid Exp(mean=1) variables.
// This is the same bias model SciPy uses for Welch average='median' correction.
function _medianBiasExp(n) {
  if (!Number.isFinite(n) || n <= 0) return 1;

  // E[X_(k)] for exponential order statistic:
  // E[X_(k)] = sum_{j=n-k+1..n} 1/j
  function expOrderStatMean(n, k) {
    let s = 0;
    for (let j = (n - k + 1); j <= n; j++) s += 1 / j;
    return s;
  }

  if (n & 1) {
    // odd: median is X_((n+1)/2)
    const k = (n + 1) >> 1;
    return expOrderStatMean(n, k);
  } else {
    // even: JS median() averages the two middle order stats
    const k = n >> 1;
    const m1 = expOrderStatMean(n, k);
    const m2 = expOrderStatMean(n, k + 1);
    return 0.5 * (m1 + m2);
  }
}
  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

function hamming(N) {
  // Match SciPy signal.get_window('hamming', N, fftbins=True)
  // i.e. periodic window: cos(2*pi*n/N)
  const w = new Float64Array(N);
  const a0 = 0.54, a1 = 0.46;
  const denom = (N || 1); // periodic, NOT (N - 1)
  for (let n = 0; n < N; n++) {
    w[n] = a0 - a1 * Math.cos((2 * Math.PI * n) / denom);
  }
  return w;
}
function hann(N) {
  const w = new Float64Array(N);
  const denom = (N - 1) || 1;
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / denom);
  }
  return w;
}
  // ------------------------- FFT (radix-2) -------------------------
  // in-place FFT on Float64Array re/im (length must be power of 2)
  function fftRadix2(re, im) {
    const n = re.length;

    // bit reversal
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        let tr = re[i]; re[i] = re[j]; re[j] = tr;
        let ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
      let m = n >> 1;
      while (m >= 1 && j >= m) { j -= m; m >>= 1; }
      j += m;
    }

    // butterflies
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1, wIm = 0;
        const half = len >> 1;
        for (let k = 0; k < half; k++) {
          const uRe = re[i + k], uIm = im[i + k];
          const vr = re[i + k + half], vi = im[i + k + half];
          const vRe = vr * wRe - vi * wIm;
          const vIm = vr * wIm + vi * wRe;

          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + half] = uRe - vRe;
          im[i + k + half] = uIm - vIm;

          const nwRe = wRe * wlenRe - wIm * wlenIm;
          const nwIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nwRe; wIm = nwIm;
        }
      }
    }
  }
function isPowerOf2(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

// In-place multiply complex arrays: (ar + i ai) *= (br + i bi)
function cmulInplace(ar, ai, br, bi) {
  for (let i = 0; i < ar.length; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    const im = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
    ai[i] = im;
  }
}

// Inverse FFT for radix-2 via conjugate trick
function ifftRadix2(re, im) {
  for (let i = 0; i < re.length; i++) im[i] = -im[i];
  fftRadix2(re, im);
  const invN = 1 / re.length;
  for (let i = 0; i < re.length; i++) {
    re[i] *= invN;
    im[i] = -im[i] * invN;
  }
}

// Bluestein FFT for arbitrary length n (complex), output length n.
function fftBluestein(re, im) {
  const n = re.length;
  if (n === 1) return { reOut: Float64Array.of(re[0]), imOut: Float64Array.of(im[0]) };

  // m = next power of 2 >= 2n-1
  let m = 1;
  while (m < (2 * n - 1)) m <<= 1;

  const aRe = new Float64Array(m);
  const aIm = new Float64Array(m);
  const bRe = new Float64Array(m);
  const bIm = new Float64Array(m);

  // a[k] = x[k] * exp(-i*pi*k^2/n)
  for (let k = 0; k < n; k++) {
    const ang = -Math.PI * (k * k) / n;
    const c = Math.cos(ang), s = Math.sin(ang);
    aRe[k] = re[k] * c - im[k] * s;
    aIm[k] = re[k] * s + im[k] * c;
  }

  // b[k] = exp(+i*pi*k^2/n), mirrored
  for (let k = 0; k < n; k++) {
    const ang = +Math.PI * (k * k) / n;
    const c = Math.cos(ang), s = Math.sin(ang);
    bRe[k] = c;
    bIm[k] = s;
    if (k !== 0) {
      bRe[m - k] = c;
      bIm[m - k] = s;
    }
  }

  // FFT(a), FFT(b) using radix-2 on length m
  fftRadix2(aRe, aIm);
  fftRadix2(bRe, bIm);

  // pointwise multiply
  cmulInplace(aRe, aIm, bRe, bIm);

  // inverse FFT
  ifftRadix2(aRe, aIm);

  // y[k] = conv[k] * exp(-i*pi*k^2/n)
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ang = -Math.PI * (k * k) / n;
    const c = Math.cos(ang), s = Math.sin(ang);
    const cr = aRe[k];
    const ci = aIm[k];
    outRe[k] = cr * c - ci * s;
    outIm[k] = cr * s + ci * c;
  }

  return { reOut: outRe, imOut: outIm };
}

// Unified FFT: radix-2 if possible else Bluestein
function fftAny(re, im) {
  const n = re.length;
  if (isPowerOf2(n)) {
    fftRadix2(re, im);
    return { reOut: re, imOut: im };
  }
  return fftBluestein(re, im);
}

  // One-sided PSD for a single segment (Welch inner loop).
  // Returns { freqs: Float64Array, pxx: Float64Array } where freqs spans [0..fs/2].
  function rfftOneSidedPxx(x, fs, win, nfft) {
  const n = x.length;

  // detrend="constant"
  let mu = 0;
  for (let i = 0; i < n; i++) mu += x[i];
  mu /= (n || 1);

  // Window + zero-pad to nfft
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);

  for (let i = 0; i < n; i++) re[i] = (x[i] - mu) * win[i];
  for (let i = n; i < nfft; i++) re[i] = 0;

  // FFT (supports non-power-of-2 via Bluestein)
  const { reOut, imOut } = fftAny(re, im);

  const nOut = Math.floor(nfft / 2) + 1;
  const freqs = new Float64Array(nOut);
  const pxx = new Float64Array(nOut);

  // SciPy welch scaling='density': |X|^2 / (fs * sum(win^2))
  let winPow = 0;
  for (let i = 0; i < n; i++) winPow += win[i] * win[i];
  winPow = winPow || 1;
  const scale = 1 / (fs * winPow);

  // one-sided doubling except DC and Nyquist (if even nfft)
  const nyqBin = (nfft % 2 === 0) ? (nfft / 2) : -1;

  for (let k = 0; k < nOut; k++) {
    freqs[k] = (k * fs) / nfft;
    const mag2 = reOut[k] * reOut[k] + imOut[k] * imOut[k];
    let val = mag2 * scale;
    if (k !== 0 && k !== nyqBin) val *= 2;
    pxx[k] = val;
  }

  return { freqs, pxx };
}

  // Welch PSD with median averaging across segments.
  // opts: { nperseg, noverlap, nfft } (samples)
function welchMedian(x, fs, opts) {
  const nperseg = opts?.nperseg ?? Math.max(8, Math.floor(fs * 5)); // 5s default
  const noverlap = opts?.noverlap ?? Math.floor(nperseg / 2);
  const step = Math.max(1, nperseg - noverlap);

  // IMPORTANT: back to nextPow2
  const nfft = opts?.nfft ?? nperseg;

  if (x.length < nperseg) {
    const pad = new Float64Array(nperseg);
    for (let i = 0; i < x.length; i++) pad[i] = x[i];
    x = pad;
  }

  const win = hamming(nperseg);
  const nOut = Math.floor(nfft / 2) + 1;

  const acc = Array.from({ length: nOut }, () => []);
  let freqsLast = null;

  for (let start = 0; start + nperseg <= x.length; start += step) {
    const seg = x.subarray(start, start + nperseg);
    const { freqs, pxx } = rfftOneSidedPxx(seg, fs, win, nfft);
    freqsLast = freqs;
    for (let k = 0; k < nOut; k++) acc[k].push(pxx[k]);
  }

  const freqs = freqsLast || new Float64Array(nOut);
const pxxMed = new Float64Array(nOut);
for (let k = 0; k < nOut; k++) {
  pxxMed[k] = median(acc[k]);
}

// SciPy-style median bias correction for average='median'
// IMPORTANT: correction depends on number of segments (K), not nperseg
const K = acc[0]?.length ?? 0;
const bias = _medianBiasExp(K) || 1;
const corr = 1 / bias;
for (let k = 0; k < nOut; k++) pxxMed[k] *= corr;

return { freqs, pxx: pxxMed, nperseg, K };
}

  // Integrate PSD over [fmin,fmax] using trapezoids.
  function bandpowerFromPxx(freqs, pxx, fmin, fmax) {
    const lo = Math.min(fmin, fmax);
    const hi = Math.max(fmin, fmax);
    let s = 0;
    for (let i = 0; i < freqs.length - 1; i++) {
      const f0 = freqs[i], f1 = freqs[i + 1];
      if (f1 < lo || f0 > hi) continue;
      const a0 = clamp(f0, lo, hi);
      const a1 = clamp(f1, lo, hi);
      const w = (a1 - a0);
      if (w <= 0) continue;

      // linear interpolate pxx at clamped endpoints
      const t0 = (a0 - f0) / (f1 - f0 || 1);
      const t1 = (a1 - f0) / (f1 - f0 || 1);
      const p0 = pxx[i] + (pxx[i + 1] - pxx[i]) * t0;
      const p1 = pxx[i] + (pxx[i + 1] - pxx[i]) * t1;

      s += 0.5 * (p0 + p1) * w;
    }
    return s;
  }
  function bandpowerFromPxx_pythonStyle(freqs, pxx, fmin, fmax) {
  const df = freqs[1] - freqs[0];
  let s = 0;

  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= fmin && freqs[i] <= fmax) {
      s += pxx[i];
    }
  }

  return s * df;
}
//---------------------------------------------------------------------------------
function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function firBandpassKernel(lowHz, highHz, fs, taps) {
  // windowed-sinc bandpass = lowpass(high) - lowpass(low)
  // then normalize gain at f0 (default 10 Hz) so |H(f0)| = 1
  const M = taps - 1;
  const h = new Float64Array(taps);

  const fc1 = lowHz / fs;   // 0..0.5
  const fc2 = highHz / fs;

  for (let n = 0; n < taps; n++) {
    const k = n - M / 2;
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M); // Hamming
    const lp2 = 2 * fc2 * sinc(2 * fc2 * k);
    const lp1 = 2 * fc1 * sinc(2 * fc1 * k);
    h[n] = (lp2 - lp1) * w;
  }

  // Normalize gain at a representative passband frequency.
  // Pick f0=10 Hz (well within 0.4–30).
  const f0 = 10.0;
  const w0 = 2 * Math.PI * (f0 / fs);

  let re = 0, im = 0;
  for (let n = 0; n < taps; n++) {
    const ang = -w0 * n;
    const c = Math.cos(ang), s = Math.sin(ang);
    re += h[n] * c;
    im += h[n] * s;
  }
  const mag = Math.sqrt(re * re + im * im) || 1;

  // Scale taps so |H(f0)| = 1
  for (let n = 0; n < taps; n++) h[n] /= mag;

  return h;
}

function firConvolveSame(x, h) {
  const n = x.length;
  const m = h.length;
  const y = new Float64Array(n);
  const half = (m - 1) >> 1;

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < m; k++) {
      const xi = i + k - half;
      if (xi >= 0 && xi < n) acc += x[xi] * h[k];
    }
    y[i] = acc;
  }
  return y;
}

function lfilterFIR(x, h) {
  // Causal FIR filter (like scipy.signal.lfilter for b=h, a=[1])
  const n = x.length;
  const m = h.length;
  const y = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    let acc = 0;
    const kmax = Math.min(i, m - 1);
    for (let k = 0; k <= kmax; k++) {
      acc += h[k] * x[i - k];
    }
    y[i] = acc;
  }
  return y;
}

function filtfiltFIR_reflect(x, h) {
  // Zero-phase FIR via forward/backward causal filtering with reflect padding
  const n = x.length;
  const m = h.length;
  const pad = Math.min(n - 1, 3 * (m - 1)); // filtfilt-ish heuristic
  if (pad <= 0) {
    // no padding possible; still do forward/backward causal
    const y1 = lfilterFIR(x, h);
    const yr = new Float64Array(y1.length);
    for (let i = 0; i < y1.length; i++) yr[i] = y1[y1.length - 1 - i];
    const y2 = lfilterFIR(yr, h);
    const y = new Float64Array(y2.length);
    for (let i = 0; i < y2.length; i++) y[i] = y2[y2.length - 1 - i];
    return y;
  }

  // Reflect padding (match your existing scheme but keep it consistent)
  const xp = new Float64Array(n + 2 * pad);

  // left reflect
  for (let i = 0; i < pad; i++) {
    xp[i] = x[pad - i];
  }
  // center
  for (let i = 0; i < n; i++) {
    xp[pad + i] = x[i];
  }
  // right reflect
  for (let i = 0; i < pad; i++) {
    xp[pad + n + i] = x[n - 2 - i];
  }

  // forward causal FIR
  const y1 = lfilterFIR(xp, h);

  // reverse
  const yr = new Float64Array(y1.length);
  for (let i = 0; i < y1.length; i++) yr[i] = y1[y1.length - 1 - i];

  // backward causal FIR
  const y2 = lfilterFIR(yr, h);

  // reverse back
  const y = new Float64Array(y2.length);
  for (let i = 0; i < y2.length; i++) y[i] = y2[y2.length - 1 - i];

  // unpad
  return y.subarray(pad, pad + n);
}
function bandpassMNE_04_30_zeroPhase_fs100(x, fs) {
  if (fs !== 100) throw new Error(`bandpassMNE_04_30_zeroPhase_fs100 expects fs=100, got ${fs}`);

  if (!MNE_FIR_0P4_30_FS100 || !Array.isArray(MNE_FIR_0P4_30_FS100.taps)) {
    throw new Error("Embedded MNE taps missing (MNE_FIR_0P4_30_FS100.taps).");
  }
  if (MNE_FIR_0P4_30_FS100.taps.length !== 825) {
    throw new Error(`MNE taps length mismatch: expected 825, got ${MNE_FIR_0P4_30_FS100.taps.length}`);
  }

  const h = Float64Array.from(MNE_FIR_0P4_30_FS100.taps);
  return filtfiltFIR_reflect(x, h);
}
function bandpassFIR_04_30_zeroPhase(x, fs) {
  if (fs !== 100) throw new Error(`bandpassFIR_04_30_zeroPhase expects fs=100, got ${fs}`);
  const taps = 401; // longer = closer to MNE FIR response
  const h = firBandpassKernel(0.4, 30.0, fs, taps);
  return filtfiltFIR_reflect(x, h);
}
  // ------------------------- resampling / downsampling -------------------------
  // Simple linear resample (works for non-integer ratios).
  function resampleLinear(x, fsIn, fsOut) {
    if (fsIn === fsOut) return Float64Array.from(x);
    const nOut = Math.max(1, Math.floor((x.length * fsOut) / fsIn));
    const y = new Float64Array(nOut);
    const scale = fsIn / fsOut;
    for (let i = 0; i < nOut; i++) {
      const t = i * scale;
      const j = Math.floor(t);
      const a = t - j;
      const x0 = (j >= 0 && j < x.length) ? x[j] : 0;
      const x1 = (j + 1 >= 0 && j + 1 < x.length) ? x[j + 1] : x0;
      y[i] = x0 * (1 - a) + x1 * a;
    }
    return y;
  }

  // If ratio is integer, do a light anti-alias via moving average then decimate.
  function decimateMovingAverage(x, factor) {
    factor = Math.max(1, Math.floor(factor));
    if (factor === 1) return Float64Array.from(x);

    const n = x.length;
    const yLen = Math.floor(n / factor);
    const y = new Float64Array(yLen);

    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += x[i];
      if ((i + 1) % factor === 0) {
        y[(i + 1) / factor - 1] = acc / factor;
        acc = 0;
      }
    }
    return y;
  }

function downsampleTo(x, fsIn, fsTarget) {
  if (fsIn === fsTarget) return Float64Array.from(x);

  // Diagnostic: if fsIn is exactly 500 Hz and target is 100 Hz, do pure decimation
  // (take every 5th sample). This avoids moving-average blur and avoids linear interpolation.
  if (fsIn === 500 && fsTarget === 100) {
    const step = 5;
    const n = Math.floor(x.length / step);
    const y = new Float64Array(n);
    for (let i = 0, j = 0; j < n; i += step, j++) {
      y[j] = x[i];
    }
    return y;
  }

  // Fallback to existing behavior for other rates
  const ratio = fsIn / fsTarget;
  if (Math.abs(ratio - Math.round(ratio)) < 1e-9) {
    return decimateMovingAverage(x, Math.round(ratio));
  }
  return resampleLinear(x, fsIn, fsTarget);
}

  // ------------------------- filtering (RBJ biquads) -------------------------
  // RBJ cookbook biquad coefficients.
  // Returns {b0,b1,b2,a1,a2} normalized with a0=1.
  function biquadLowpass(fc, fs, Q) {
    const w0 = 2 * Math.PI * (fc / fs);
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * Q);

    let b0 = (1 - cosw0) / 2;
    let b1 = (1 - cosw0);
    let b2 = (1 - cosw0) / 2;
    let a0 = 1 + alpha;
    let a1 = -2 * cosw0;
    let a2 = 1 - alpha;

    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    return { b0, b1, b2, a1, a2 };
  }

  function biquadHighpass(fc, fs, Q) {
    const w0 = 2 * Math.PI * (fc / fs);
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * Q);

    let b0 = (1 + cosw0) / 2;
    let b1 = -(1 + cosw0);
    let b2 = (1 + cosw0) / 2;
    let a0 = 1 + alpha;
    let a1 = -2 * cosw0;
    let a2 = 1 - alpha;

    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    return { b0, b1, b2, a1, a2 };
  }

  function applyBiquad(x, c) {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const { b0, b1, b2, a1, a2 } = c;
    for (let i = 0; i < x.length; i++) {
      const x0 = x[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      y[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    return y;
  }

function firLowpassKernel(cutoffHz, fs, taps) {
  // windowed-sinc lowpass, Hamming window
  // cutoffHz: e.g. 40 for decim 500->100 (Nyquist target=50, keep passband <= 40)
  const fc = cutoffHz / fs; // normalized (cycles/sample), 0..0.5
  const M = taps - 1;
  const h = new Float64Array(taps);

  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - M / 2;
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M); // Hamming
    const val = 2 * fc * sinc(2 * fc * k) * w;
    h[n] = val;
    sum += val;
  }

  // normalize DC gain to 1
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

function firConvolve(x, h) {
  const n = x.length;
  const m = h.length;
  const y = new Float64Array(n);
  const half = (m - 1) >> 1;

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < m; k++) {
      const xi = i + k - half;
      if (xi >= 0 && xi < n) acc += x[xi] * h[k];
    }
    y[i] = acc;
  }
  return y;
}

function filtfiltFIR_zeroPad(x, h) {
  // zero-phase FIR by forward/backward filtering (no padding)
  const y1 = firConvolve(x, h);
  // reverse
  const yr = new Float64Array(y1.length);
  for (let i = 0; i < y1.length; i++) yr[i] = y1[y1.length - 1 - i];
  const y2 = firConvolve(yr, h);
  // reverse back
  const y = new Float64Array(y2.length);
  for (let i = 0; i < y2.length; i++) y[i] = y2[y2.length - 1 - i];
  return y;
}

function decimateBy5(x) {
  const n = Math.floor(x.length / 5);
  const y = new Float64Array(n);
  for (let i = 0, j = 0; j < n; i += 5, j++) y[j] = x[i];
  return y;
}

// Embedded SciPy resample_poly up=1 down=5 taps (numtaps=51, kaiser beta=5.0)
// Source: resample_poly_1_5_taps.json
const __RESAMPLE_POLY_1_5__ = {
  up: 1,
  down: 5,
  numtaps: 51,
  // window: ["kaiser", 5.0], // optional metadata
  taps: [
    2.859538743196648e-19,
    0.00044416518279544474,
    0.001070047537789414,
    0.0015101606474802404,
    0.0012681925150387202,
    -1.395681549678798e-18,
    -0.002162523182766222,
    -0.004437557288311246,
    -0.005545296083261551,
    -0.004230782710070817,
    3.231828369471854e-18,
    0.006267437155630011,
    0.012212956279145735,
    0.014637971601615465,
    0.010809978571131596,
    -5.376257191955568e-18,
    -0.015415675636577007,
    -0.029917903114928462,
    -0.03615578805611705,
    -0.027348797164004315,
    7.118002423723586e-18,
    0.04412122397186862,
    0.09761881672202957,
    0.14908021048168216,
    0.1862629069603875,
    0.19982051121888422,
    0.1862629069603875,
    0.14908021048168216,
    0.09761881672202957,
    0.04412122397186862,
    7.118002423723586e-18,
    -0.027348797164004315,
    -0.03615578805611705,
    -0.029917903114928462,
    -0.015415675636577007,
    -5.376257191955568e-18,
    0.010809978571131596,
    0.014637971601615465,
    0.012212956279145735,
    0.006267437155630011,
    3.231828369471854e-18,
    -0.004230782710070817,
    -0.005545296083261551,
    -0.004437557288311246,
    -0.002162523182766222,
    -1.395681549678798e-18,
    0.0012681925150387202,
    0.0015101606474802404,
    0.001070047537789414,
    0.00044416518279544474,
    2.859538743196648e-19
  ],
};

let __resamplePoly15Taps = null;

// Keep async so existing callers can `await` it, but it never fetches.
async function __loadResamplePoly15TapsOnce() {
  if (__resamplePoly15Taps) return __resamplePoly15Taps;

  const j = __RESAMPLE_POLY_1_5__;
  if (!j || j.up !== 1 || j.down !== 5) {
    throw new Error(`Expected up=1 down=5, got up=${j?.up} down=${j?.down}`);
  }
  const taps = j.taps;
  if (!taps || taps.length !== 51) {
    throw new Error(`Embedded resample_poly taps missing/invalid (len=${taps ? taps.length : "null"})`);
  }

  __resamplePoly15Taps = Float64Array.from(taps);
  return __resamplePoly15Taps;
}

// reflect padding helper (same spirit as your filtfiltFIR_reflect)
function __reflectPad1D(x, pad) {
  const n = x.length;
  const p = Math.min(pad, n - 1);
  if (p <= 0) return Float64Array.from(x);

  const xp = new Float64Array(n + 2 * p);
  // left reflect around x[0]: x[1..p] reversed
  for (let i = 0; i < p; i++) xp[i] = x[p - i];
  // center
  for (let i = 0; i < n; i++) xp[p + i] = x[i];
  // right reflect around x[n-1]: x[n-p-2..n-2] reversed
  for (let i = 0; i < p; i++) xp[p + n + i] = x[n - 2 - i];

  return xp;
}

// polyphase FIR downsample: y[m] = sum_k h[k] * x[m*D - k]
function __downsampleFIR(x, h, D) {
  const n = x.length;
  const M = h.length;

  // Output length: floor((n - 1) / D) + 1, but we’ll compute safe bound
  const outLen = Math.floor((n - 1) / D) + 1;
  const y = new Float64Array(outLen);

  for (let m = 0; m < outLen; m++) {
    const t = m * D;
    let acc = 0;
    // FIR dot around index t
    for (let k = 0; k < M; k++) {
      const xi = t - k;
      if (xi >= 0 && xi < n) acc += h[k] * x[xi];
    }
    y[m] = acc;
  }
  return y;
}

// Async so we can load taps once
async function resample500To100Polyphase(x) {
  const h = await __loadResamplePoly15TapsOnce();

  // pad similar scale to SciPy-ish anti-edge behavior:
  // keep it consistent with your other pad heuristic
  const pad = Math.min(x.length - 1, 3 * (h.length - 1));
  const xp = __reflectPad1D(x, pad);

  // filter+downsample
  const y = __downsampleFIR(xp, h, 5);

  // remove pad effect: map output indices back roughly to original support
  // We want samples corresponding to the center region.
  // Start output near pad/5 and keep floor(n/5) samples.
  const start = Math.floor(pad / 5);
  const outN = Math.floor(x.length / 5);
  return y.subarray(start, start + outN);
}

// DROP-IN wrapper matching your old signature
async function resample500To100FIR(x) {
  // replace old path with polyphase
  return resample500To100Polyphase(Float64Array.from(x));
}
  // A practical bandpass: cascade HP then LP, each applied twice (≈4th-order overall).
  function bandpass04_30(x, fs, fLo, fHi) {
    const lo = Math.max(0.0001, fLo);
    const hi = Math.min(0.499 * fs, fHi);
    const Q = Math.SQRT1_2; // ~0.707 (Butterworth-ish)

    let y = Float64Array.from(x);
    // highpass twice
    const hp = biquadHighpass(lo, fs, Q);
    y = applyBiquad(y, hp);
    y = applyBiquad(y, hp);
    // lowpass twice
    const lp = biquadLowpass(hi, fs, Q);
    y = applyBiquad(y, lp);
    y = applyBiquad(y, lp);
    return y;
  }

  // ------------------------- exported API -------------------------
  // --- export API with names expected by yasa_staging.js ---
  const api = {
    // expected names:
	resampleTo100Hz: async (x, fsIn) => {
	  let y;
	  if (fsIn === 100) {
		y = Float64Array.from(x);
	  } else if (fsIn === 500) {
		y = await resample500To100FIR(Float64Array.from(x));
	  } else {
		y = downsampleTo(x, fsIn, 100);
	  }

	  // DEBUG: export epoch0 after downsample/resample (pre-bandpass)
	  if (__DEBUG_EXPORTS__ && !__didExportDownsampleOnly__) {
		__didExportDownsampleOnly__ = true;
		__debugExportJson("js_epoch0_downsample_only.json", __firstEpochJson(y, 100));
	  }

	  return y;
	},
    // Async MNE FIR bandpass (exact taps from MNE JSON)
    bandpass_04_30_async: async (x, fs) => {
	  const y = await bandpassMNE_04_30_zeroPhase_fs100_async(x, fs);

	  // DEBUG: export epoch0 after bandpass
	  if (__DEBUG_EXPORTS__ && !__didExportBandpass__) {
		__didExportBandpass__ = true;
		__debugExportJson("js_epoch0_bandpass.json", __firstEpochJson(y, fs));
	  }

	  return y;
	},

    // Sync fallback (kept so older callers don't explode)
	bandpass_04_30: (x, fs) => bandpassMNE_04_30_zeroPhase_fs100(x, fs),
  
    // expected by yasa_features.js if you used my earlier feature code:
welchMedianPSD: (epoch, fs, nperseg) => {
  const { freqs, pxx } = welchMedian(epoch, fs, { nperseg });
  return { freqs, psd: pxx };
},
    trapzBand: (psd, freqs, f0, f1) => bandpowerFromPxx_pythonStyle(freqs, psd, f0, f1),
  
    // also expose originals (optional)
    _downsampleTo: downsampleTo,
    _bandpowerFromPxx: bandpowerFromPxx,
    _welchMedian: welchMedian,
	bandpassFIR_04_30_zeroPhase,
  };
  
  window.YASA_DSP = api;
})();
