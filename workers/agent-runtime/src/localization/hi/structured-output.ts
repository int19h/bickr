export default {
	"structured_output.unexpected_tools.compaction": "META: टूल कॉल न करें। आवश्यक JSON स्कीमा का पालन करने वाले, प्रथम पुरुष में लिखे विस्तृत सारांश से जवाब दें।",
	"structured_output.unexpected_tools.other": "इस जवाब के लिए Bickr नियंत्रण का उपयोग न करें। केवल {{property}} वाले आवश्यक JSON ऑब्जेक्ट से जवाब दें।",
	"structured_output.empty.compaction": "सारांश वाला जवाब खाली था। {{property}} में गैर-खाली पाठ वाला JSON ऑब्जेक्ट लौटाएँ।",
	"structured_output.empty.translation": "अनुवाद वाला जवाब खाली था। {{property}} में गैर-खाली पाठ वाला JSON ऑब्जेक्ट लौटाएँ।",
	"structured_output.empty.avatar_description": "प्रोफ़ाइल चित्र के विवरण वाला जवाब खाली था। {{property}} में गैर-खाली पाठ वाला JSON ऑब्जेक्ट लौटाएँ।",
	"structured_output.invalid_json.compaction": "सारांश वाला जवाब JSON ऑब्जेक्ट होना आवश्यक है। केवल {{property}} उसके पाठ मान के साथ दें।",
	"structured_output.invalid_json.translation": "अनुवाद वाला जवाब JSON ऑब्जेक्ट होना आवश्यक है। केवल {{property}} उसके पाठ मान के साथ दें।",
	"structured_output.invalid_json.avatar_description": "प्रोफ़ाइल चित्र के विवरण वाला जवाब JSON ऑब्जेक्ट होना आवश्यक है। केवल {{property}} उसके पाठ मान के साथ दें।",
	"structured_output.missing_tool": "कोई {{toolName}} टूल कॉल नहीं लौटाई गई। {{property}} में खाली न रहने वाले टेक्स्ट के साथ {{toolName}} को एक बार कॉल करें।",
	"structured_output.wrong_tool": "इस अनुरोध के लिए केवल {{toolName}} का उपयोग करें। यहाँ {{receivedTool}} का उपयोग न करें।",
	"structured_output.tool_count": {
		"one": "एक {{toolName}} टूल कॉल की अपेक्षा थी, पर प्राप्त कॉल की संख्या {{count}} है। {{toolName}} को ठीक एक बार कॉल करें।",
		"other": "एक {{toolName}} टूल कॉल की अपेक्षा थी, पर प्राप्त कॉल की संख्या {{count}} है। {{toolName}} को ठीक एक बार कॉल करें।"
	},
	"structured_output.tool_mismatch": "{{toolName}} टूल अपेक्षित था, लेकिन {{receivedTool}} मिला। इसके बजाय {{toolName}} को कॉल करें।",
	"structured_output.invalid_arguments_json": "{{toolName}} के आर्ग्युमेंट मान्य JSON नहीं थे। {{property}} में टेक्स्ट वाला JSON ऑब्जेक्ट दें। स्ट्रिंग में विशेष वर्णों को एस्केप करें।",
	"structured_output.arguments_object": "{{toolName}} के आर्ग्युमेंट JSON ऑब्जेक्ट होना आवश्यक है। {{property}} और उसका पाठ मान {} के भीतर रखें।",
	"structured_output.output_object": "संरचित आउटपुट JSON ऑब्जेक्ट होना आवश्यक है। {{property}} और उसका पाठ मान {} के भीतर रखें।",
	"structured_output.extra_arguments": {
		"one": "अनपेक्षित आर्ग्युमेंट की संख्या {{count}} है: {{fields}}। दिखाया गया हर आर्ग्युमेंट हटाएँ। केवल {{property}} दें।",
		"other": "अनपेक्षित आर्ग्युमेंट की संख्या {{count}} है: {{fields}}। दिखाया गया हर आर्ग्युमेंट हटाएँ। केवल {{property}} दें।"
	},
	"structured_output.extra_fields": {
		"one": "अनपेक्षित फ़ील्ड की संख्या {{count}} है: {{fields}}। दिखाया गया हर फ़ील्ड हटाएँ। केवल {{property}} दें।",
		"other": "अनपेक्षित फ़ील्ड की संख्या {{count}} है: {{fields}}। दिखाया गया हर फ़ील्ड हटाएँ। केवल {{property}} दें।"
	},
	"structured_output.nonempty.compaction": "सारांश आर्ग्युमेंट गैर-खाली स्ट्रिंग होना आवश्यक है। पाठ {{property}} में रखें।",
	"structured_output.nonempty.translation": "अनुवाद आर्ग्युमेंट गैर-खाली स्ट्रिंग होना आवश्यक है। पाठ {{property}} में रखें।",
	"structured_output.nonempty.avatar_description": "प्रोफ़ाइल चित्र के विवरण का आर्ग्युमेंट गैर-खाली स्ट्रिंग होना आवश्यक है। पाठ {{property}} में रखें।",
	"structured_output.transcript": "{{property}} में सारांश प्रथम पुरुष में सामान्य गद्य के रूप में लिखें। प्रतिलेख की लाइन {{line}} हटाएँ। {{labels}} लेबल वाली लाइनें न लिखें।",
	"structured_output.minimum.compaction": {
		"one": "{{property}} में सारांश कम से कम {{minimum}} वर्ण का होना आवश्यक है। पाठ में प्रासंगिक विवरण जोड़ें।",
		"other": "{{property}} में सारांश कम से कम {{minimum}} वर्ण का होना आवश्यक है। पाठ में प्रासंगिक विवरण जोड़ें।"
	},
	"structured_output.minimum.translation": {
		"one": "{{property}} में अनुवाद कम से कम {{minimum}} वर्ण का होना आवश्यक है। पाठ में प्रासंगिक विवरण जोड़ें।",
		"other": "{{property}} में अनुवाद कम से कम {{minimum}} वर्ण का होना आवश्यक है। पाठ में प्रासंगिक विवरण जोड़ें।"
	},
	"structured_output.minimum.avatar_description": {
		"one": "{{property}} में प्रोफ़ाइल चित्र का वर्णन कम से कम {{minimum}} वर्ण का होना आवश्यक है। पाठ में प्रासंगिक विवरण जोड़ें।",
		"other": "{{property}} में प्रोफ़ाइल चित्र का वर्णन कम से कम {{minimum}} वर्ण का होना आवश्यक है। पाठ में प्रासंगिक विवरण जोड़ें।"
	},
	"structured_output.maximum.compaction": {
		"one": "{{property}} में सारांश अधिकतम {{maximum}} वर्ण का होना आवश्यक है। पाठ छोटा करें।",
		"other": "{{property}} में सारांश अधिकतम {{maximum}} वर्ण का होना आवश्यक है। पाठ छोटा करें।"
	},
	"structured_output.maximum.translation": {
		"one": "{{property}} में अनुवाद अधिकतम {{maximum}} वर्ण का होना आवश्यक है। पाठ छोटा करें।",
		"other": "{{property}} में अनुवाद अधिकतम {{maximum}} वर्ण का होना आवश्यक है। पाठ छोटा करें।"
	},
	"structured_output.maximum.avatar_description": {
		"one": "{{property}} में प्रोफ़ाइल चित्र का वर्णन अधिकतम {{maximum}} वर्ण का होना आवश्यक है। पाठ छोटा करें।",
		"other": "{{property}} में प्रोफ़ाइल चित्र का वर्णन अधिकतम {{maximum}} वर्ण का होना आवश्यक है। पाठ छोटा करें।"
	},
	"structured_output.wrong_tool.unnamed": "इस अनुरोध के लिए केवल {{toolName}} का उपयोग करें। बिना नाम वाली टूल कॉल न भेजें।",
	"structured_output.tool_mismatch.unnamed": "{{toolName}} टूल अपेक्षित था, लेकिन बिना नाम वाली टूल कॉल मिली। इसके बजाय {{toolName}} को कॉल करें।",
	"structured_output.nonreducing.estimate": {
		"one": "{{property}} में सारांश से संदर्भ कम नहीं हुआ। उसकी अनुमानित लंबाई {{replacementTokens}} टोकन है।",
		"other": "{{property}} में सारांश से संदर्भ कम नहीं हुआ। उसकी अनुमानित लंबाई {{replacementTokens}} टोकन है।"
	},
	"structured_output.nonreducing.before": {
		"one": "प्रतिस्थापन से पहले संदर्भ में टोकन की संख्या {{compactedTokens}} थी। आवश्यक तथ्य रखते हुए सारांश छोटा करें।",
		"other": "प्रतिस्थापन से पहले संदर्भ में टोकन की संख्या {{compactedTokens}} थी। आवश्यक तथ्य रखते हुए सारांश छोटा करें।"
	},
	"structured_output.nonempty.compaction.field": "सारांश फ़ील्ड गैर-खाली स्ट्रिंग होना आवश्यक है। पाठ {{property}} में रखें।",
	"structured_output.nonempty.translation.field": "अनुवाद फ़ील्ड गैर-खाली स्ट्रिंग होना आवश्यक है। पाठ {{property}} में रखें।",
	"structured_output.nonempty.avatar_description.field": "प्रोफ़ाइल चित्र के विवरण का फ़ील्ड गैर-खाली स्ट्रिंग होना आवश्यक है। पाठ {{property}} में रखें।"
} as const;
